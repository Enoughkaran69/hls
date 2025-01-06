const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const url = require("url");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware setup
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
}

function parseFFProbeOutput(stderr) {
    const streams = [];
    let currentStream = null;
    const lines = stderr.split('\n');

    for (const line of lines) {
        if (line.includes('Stream #')) {
            if (currentStream) {
                streams.push(currentStream);
            }
            currentStream = { index: 0, type: '', codec: '', details: {} };
            
            // Extract stream index
            const indexMatch = line.match(/Stream #0:(\d+)/);
            if (indexMatch) {
                currentStream.index = parseInt(indexMatch[1]);
            }

            // Determine stream type and basic info
            if (line.includes('Video:')) {
                currentStream.type = 'video';
                // Extract video codec
                const codecMatch = line.match(/Video: ([^,]+)/);
                if (codecMatch) {
                    currentStream.codec = codecMatch[1].trim();
                }
                // Extract resolution
                const resMatch = line.match(/(\d+x\d+)/);
                if (resMatch) {
                    currentStream.details.resolution = resMatch[1];
                }
                // Extract bitrate
                const bitrateMatch = line.match(/(\d+) kb\/s/);
                if (bitrateMatch) {
                    currentStream.details.bitrate = `${bitrateMatch[1]} kb/s`;
                }
                // Extract FPS
                const fpsMatch = line.match(/(\d+(?:\.\d+)?) fps/);
                if (fpsMatch) {
                    currentStream.details.fps = `${fpsMatch[1]} fps`;
                }
            } else if (line.includes('Audio:')) {
                currentStream.type = 'audio';
                // Extract audio codec
                const codecMatch = line.match(/Audio: ([^,]+)/);
                if (codecMatch) {
                    currentStream.codec = codecMatch[1].trim();
                }
                // Extract sample rate
                const sampleMatch = line.match(/(\d+) Hz/);
                if (sampleMatch) {
                    currentStream.details.sampleRate = `${sampleMatch[1]} Hz`;
                }
                // Extract channels
                const channelMatch = line.match(/stereo|mono|(\d+) channels/i);
                if (channelMatch) {
                    currentStream.details.channels = channelMatch[0];
                }
                // Extract language if available
                const langMatch = line.match(/\(([a-z]{2,3})\)/i);
                if (langMatch) {
                    currentStream.details.language = langMatch[1];
                }
                // Extract bitrate
                const bitrateMatch = line.match(/(\d+) kb\/s/);
                if (bitrateMatch) {
                    currentStream.details.bitrate = `${bitrateMatch[1]} kb/s`;
                }
            }
        }
    }
    
    if (currentStream) {
        streams.push(currentStream);
    }

    return streams;
}

app.post("/getStreams", async (req, res) => {
    try {
        const { hlsUrl } = req.body;
        
        if (!hlsUrl) {
            return res.status(400).json({ error: "HLS URL is required" });
        }

        // Use ffprobe to get detailed stream information
        const command = `ffprobe -v error -show_entries stream=codec_name,codec_type -show_entries stream_tags=language -of json "${hlsUrl}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("FFprobe error:", error);
                return res.status(500).json({ error: "Failed to analyze stream" });
            }

            const streams = parseFFProbeOutput(stderr);
            res.json({ streams });
        });
    } catch (error) {
        console.error("Stream analysis error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/downloadStream", async (req, res) => {
    try {
        const { hlsUrl, videoIndex, audioIndex, duration } = req.body;
        
        if (!hlsUrl) {
            return res.status(400).json({ error: "HLS URL is required" });
        }

        const uniqueId = crypto.randomBytes(8).toString('hex');
        const outputPath = path.join(DOWNLOADS_DIR, `stream_${uniqueId}.mp4`);

        // Build ffmpeg command based on selected streams
        let ffmpegCommand = ['ffmpeg', '-i', hlsUrl];

        // Add video stream mapping if specified
        if (videoIndex !== undefined) {
            ffmpegCommand.push('-map', `0:${videoIndex}`);
        }

        // Add audio stream mapping if specified
        if (audioIndex !== undefined) {
            ffmpegCommand.push('-map', `0:${audioIndex}`);
        }

        // Add duration limit if specified
        if (duration) {
            ffmpegCommand.push('-t', duration.toString());
        }

        // Add output options
        ffmpegCommand.push('-c', 'copy', outputPath);

        const ffmpegProcess = spawn(ffmpegCommand[0], ffmpegCommand.slice(1));

        let totalDuration = null;
        let progressTime = 0;

        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();

            // Extract duration if not already found
            if (!totalDuration) {
                const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}.\d{2})/);
                if (durationMatch) {
                    const [, hours, minutes, seconds] = durationMatch;
                    totalDuration = (parseFloat(hours) * 3600) +
                                  (parseFloat(minutes) * 60) +
                                  parseFloat(seconds);
                }
            }

            // Extract current time
            const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
            if (timeMatch && totalDuration) {
                const [, hours, minutes, seconds] = timeMatch;
                progressTime = (parseFloat(hours) * 3600) +
                             (parseFloat(minutes) * 60) +
                             parseFloat(seconds);
                
                const progress = Math.min((progressTime / totalDuration) * 100, 100);
                
                // Send progress through WebSocket
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'progress',
                            progress: Math.round(progress),
                            currentTime: progressTime,
                            totalTime: totalDuration,
                            filename: path.basename(outputPath)
                        }));
                    }
                });
            }
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                res.download(outputPath, `download.mp4`, (err) => {
                    if (err) {
                        console.error("Download error:", err);
                    }
                    // Clean up the file after sending
                    fs.unlink(outputPath, () => {});
                });
            } else {
                res.status(500).json({ error: "Download failed" });
                fs.unlink(outputPath, () => {});
            }
        });

    } catch (error) {
        console.error("Download error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

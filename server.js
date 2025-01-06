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

const parseFFMpegStreams = (stderr) => {
    const streamDetails = [];
    // Enhanced regex patterns for better stream detection
    const videoPattern = /Stream #(\d+):(\d+)(?:\[0x[0-9a-f]+\])?[^\n]*: Video: ([^\s,]+)(?:.*?(\d+x\d+))?.*?(?:(\d+(?:\.\d+)?) fps)?.*?(?:(\d+) kb\/s)?/gi;
    const audioPattern = /Stream #(\d+):(\d+)(?:\[0x[0-9a-f]+\])?[^\n]*: Audio: ([^\s,]+).*?, ([^,]+)(?:.*?(\d+) Hz)?.*?(?:(\d+) kb\/s)?(?:.*?\[(.*?)\])?/gi;

    // Parse video streams
    let match;
    while ((match = videoPattern.exec(stderr)) !== null) {
        const [_, streamNum, index, codec, resolution, fps, bitrate] = match;
        streamDetails.push({
            index: parseInt(index),
            type: 'video',
            codec: codec,
            resolution: resolution || 'N/A',
            fps: fps || 'N/A',
            bitrate: bitrate ? `${bitrate} kb/s` : 'N/A',
            streamIndex: `${streamNum}:${index}`
        });
    }

    // Parse audio streams
    while ((match = audioPattern.exec(stderr)) !== null) {
        const [_, streamNum, index, codec, layout, sampleRate, bitrate, language] = match;
        streamDetails.push({
            index: parseInt(index),
            type: 'audio',
            codec: codec,
            layout: layout,
            sampleRate: sampleRate ? `${sampleRate} Hz` : 'N/A',
            bitrate: bitrate ? `${bitrate} kb/s` : 'N/A',
            language: language || 'und',
            streamIndex: `${streamNum}:${index}`
        });
    }

    // Log the detected streams for debugging
    console.log('Detected streams:', JSON.stringify(streamDetails, null, 2));

    return streamDetails;
};

// Modify the getStreams endpoint to include more information
app.post("/getStreams", (req, res) => {
    const { hlsUrl } = req.body;

    if (!hlsUrl) {
        return res.status(400).send("HLS URL is required.");
    }

    // Use ffprobe instead of ffmpeg for better stream information
    const command = `ffprobe -v error -show_entries stream=index,codec_name,codec_type,width,height,sample_rate,channels,channel_layout -of json "${hlsUrl}"`;

    exec(command, (error, stdout, stderr) => {
        if (error && !stderr) {
            console.error(`exec error: ${error}`);
            return res.status(500).send("Failed to fetch stream information.");
        }

        const streams = parseFFMpegStreams(stderr);
        console.log('Sending stream information to client:', streams);
        res.json({ streams });
    });
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

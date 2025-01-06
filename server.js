const express = require("express");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");
const https = require("https");
const http = require("http");
const url = require("url");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server separately for better WebSocket handling
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware setup
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Constants and configurations
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1GB limit
const ALLOWED_FORMATS = ['.m3u8', '.ts'];
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
}

// Rate limiting setup
const downloadRequests = new Map();
const RATE_LIMIT = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10 // limit each IP to 10 requests per windowMs
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`Client connected from ${clientIP}`);
    
    ws.on('close', () => {
        console.log(`Client disconnected from ${clientIP}`);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientIP}:`, error);
    });
});

// Utility Functions
function sanitizeUrl(inputUrl) {
    try {
        const parsed = new URL(inputUrl);
        // Only allow HTTP and HTTPS protocols
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return null;
        }
        return parsed.toString();
    } catch (e) {
        return null;
    }
}

function isValidStreamFormat(hlsUrl) {
    const ext = path.extname(url.parse(hlsUrl).pathname).toLowerCase();
    return ALLOWED_FORMATS.includes(ext);
}

async function checkUrlExists(hlsUrl) {
    const parsedUrl = url.parse(hlsUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
        const req = protocol.get(hlsUrl, (response) => {
            resolve(response.statusCode === 200);
        });

        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

function parseFFMpegStreams(stderr) {
    const streamDetails = [];
    const patterns = {
        video: /Stream #\d+:(\d+)(?:\[0x[0-9a-f]+\])?[^\n]*: Video: ([^\s,]+)(?:.*?(\d+)x(\d+))?.*?(?:(\d+(?:\.\d+)?) fps)?/g,
        audio: /Stream #\d+:(\d+)(?:\[0x[0-9a-f]+\])?[^\n]*: Audio: ([^\s,]+).*?(\d+) Hz.*?(?:(\d+) kb\/s)?/g
    };

    let match;
    while ((match = patterns.video.exec(stderr)) !== null) {
        streamDetails.push({
            index: parseInt(match[1]),
            type: "video",
            codec: match[2],
            resolution: match[3] && match[4] ? `${match[3]}x${match[4]}` : "N/A",
            fps: match[5] || "N/A"
        });
    }

    while ((match = patterns.audio.exec(stderr)) !== null) {
        streamDetails.push({
            index: parseInt(match[1]),
            type: "audio",
            codec: match[2],
            sampleRate: `${match[3]} Hz`,
            bitrate: match[4] ? `${match[4]} kb/s` : "N/A"
        });
    }

    return streamDetails;
}

// Request Handlers
app.post("/getStreams", async (req, res) => {
    try {
        const { hlsUrl } = req.body;
        
        if (!hlsUrl) {
            return res.status(400).json({ error: "HLS URL is required" });
        }

        const sanitizedUrl = sanitizeUrl(hlsUrl);
        if (!sanitizedUrl) {
            return res.status(400).json({ error: "Invalid URL format" });
        }

        if (!isValidStreamFormat(sanitizedUrl)) {
            return res.status(400).json({ error: "Invalid stream format" });
        }

        const exists = await checkUrlExists(sanitizedUrl);
        if (!exists) {
            return res.status(404).json({ error: "Stream not accessible" });
        }

        const command = `ffmpeg -i "${sanitizedUrl}"`;
        exec(command, (error, stdout, stderr) => {
            if (error && !stderr) {
                return res.status(500).json({ error: "Failed to analyze stream" });
            }

            const streams = parseFFMpegStreams(stderr);
            res.json({ streams });
        });
    } catch (error) {
        console.error("Stream analysis error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/downloadStream", async (req, res) => {
    try {
        const { hlsUrl, streamIndex } = req.body;
        const clientIP = req.ip;

        // Rate limiting check
        if (downloadRequests.has(clientIP)) {
            const requests = downloadRequests.get(clientIP);
            if (requests.count >= RATE_LIMIT.max) {
                if (Date.now() - requests.timestamp < RATE_LIMIT.windowMs) {
                    return res.status(429).json({ error: "Too many download requests" });
                }
                downloadRequests.delete(clientIP);
            }
        }

        if (!hlsUrl || streamIndex === undefined) {
            return res.status(400).json({ error: "URL and stream index required" });
        }

        const sanitizedUrl = sanitizeUrl(hlsUrl);
        if (!sanitizedUrl) {
            return res.status(400).json({ error: "Invalid URL format" });
        }

        const exists = await checkUrlExists(sanitizedUrl);
        if (!exists) {
            return res.status(404).json({ error: "Stream not accessible" });
        }

        // Create unique filename with random component
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const outputPath = path.join(DOWNLOADS_DIR, `stream_${uniqueId}.mp4`);

        const ffmpegCommand = `ffmpeg -i "${sanitizedUrl}" -map 0:${streamIndex} -c copy -y "${outputPath}"`;
        
        const ffmpegProcess = exec(ffmpegCommand);
        let duration = null;
        let progress = 0;

        // Set download timeout
        const timeoutId = setTimeout(() => {
            ffmpegProcess.kill();
            fs.unlink(outputPath, () => {});
            return res.status(408).json({ error: "Download timeout" });
        }, DOWNLOAD_TIMEOUT);

        ffmpegProcess.stderr.on("data", (data) => {
            // Extract duration if not already found
            if (!duration) {
                const durationMatch = data.toString().match(/Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (durationMatch) {
                    duration = durationMatch[1];
                }
            }

            // Extract progress
            const timeMatch = data.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
            if (timeMatch && duration) {
                progress = calculateProgress(timeMatch[1], duration);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ 
                            progress,
                            filename: path.basename(outputPath)
                        }));
                    }
                });
            }
        });

        ffmpegProcess.on("close", (code) => {
            clearTimeout(timeoutId);

            if (code === 0) {
                res.download(outputPath, `stream_${streamIndex}.mp4`, (err) => {
                    if (err) {
                        console.error("Download error:", err);
                    }
                    fs.unlink(outputPath, () => {});
                });

                // Update rate limiting
                const now = Date.now();
                if (downloadRequests.has(clientIP)) {
                    const requests = downloadRequests.get(clientIP);
                    requests.count++;
                } else {
                    downloadRequests.set(clientIP, { count: 1, timestamp: now });
                }
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

// Helper function to calculate progress percentage
function calculateProgress(currentTime, totalDuration) {
    const timeToSeconds = (timeString) => {
        const [hours, minutes, seconds] = timeString.split(':').map(parseFloat);
        return hours * 3600 + minutes * 60 + seconds;
    };

    const current = timeToSeconds(currentTime);
    const total = timeToSeconds(totalDuration);
    return Math.round((current / total) * 100);
}

// Start server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// Cleanup on server shutdown
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Server shutdown complete');
        // Clean up downloads directory
        fs.readdir(DOWNLOADS_DIR, (err, files) => {
            if (err) return;
            files.forEach(file => {
                fs.unlink(path.join(DOWNLOADS_DIR, file), () => {});
            });
        });
    });
});

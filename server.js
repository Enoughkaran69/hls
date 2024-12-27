const express = require("express");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");
const https = require("https");
const url = require("url");

const app = express();
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ noServer: true });

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to parse JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure a downloads directory exists
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Handle the WebSocket connection
wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Endpoint to fetch stream info
app.post("/getStreams", (req, res) => {
    const { hlsUrl } = req.body;

    if (!hlsUrl) {
        return res.status(400).send("HLS URL is required.");
    }

    // Get stream info using ffmpeg
    const command = `ffmpeg -i "${hlsUrl}"`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).send("Failed to fetch stream information.");
        }

        const streams = parseFFMpegStreams(stderr); // Custom function to extract stream info from ffmpeg output

        // Send stream information back to client
        res.json({ streams });
    });
});

// Endpoint to download a specific stream
app.post("/downloadStream", (req, res) => {
    const { hlsUrl, streamIndex } = req.body;

    if (!hlsUrl || streamIndex === undefined) {
        return res.status(400).send("HLS URL and stream index are required.");
    }

    checkUrlExists(hlsUrl, (exists) => {
        if (!exists) {
            return res.status(404).send("HLS URL is not reachable.");
        }

        // Create a unique file path for saving the video
        const outputPath = path.join(downloadsDir, `output_${Date.now()}.mp4`);

        // ffmpeg command to download the selected stream (video/audio)
        const command = `ffmpeg -i "${hlsUrl}" -map 0:v:${streamIndex} -c copy "${outputPath}"`; // For video only

        // Track progress
        let progressOutput = "";
        const ffmpegProcess = exec(command);

        // Capture ffmpeg output for progress tracking
        ffmpegProcess.stdout.on("data", (data) => {
            progressOutput += data.toString();
            const match = progressOutput.match(/time=(\d+:\d+:\d+\.\d+)/);
            if (match) {
                const time = match[1];
                console.log(`Progress: ${time}`);
                // Send progress to WebSocket clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ progress: time }));
                    }
                });
            }
        });

        ffmpegProcess.stderr.on("data", (data) => {
            console.error(`stderr: ${data}`);
        });

        ffmpegProcess.on("close", (code) => {
            if (code === 0) {
                console.log("Download complete!");
                res.download(outputPath, `stream_${streamIndex + 1}.mp4`, (err) => {
                    if (err) {
                        console.error(err);
                    }
                    // Clean up the file after sending
                    fs.unlinkSync(outputPath);
                });
            } else {
                console.error(`ffmpeg process exited with code ${code}`);
                res.status(500).send("Failed to process the HLS link.");
            }
        });
    });
});

// Helper function to extract stream info from ffmpeg output
function parseFFMpegStreams(stderr) {
    const streamDetails = [];
    const videoRegex = /Stream #\d+:(\d+)[^:]*: Video: (.*), (\d+)x(\d+)/g;
    const audioRegex = /Stream #\d+:(\d+)[^:]*: Audio: (.*), (\d+) Hz/g;

    let match;
    // Parse video streams
    while ((match = videoRegex.exec(stderr)) !== null) {
        streamDetails.push({
            type: "video",
            resolution: `${match[3]}x${match[4]}`,
            codec: match[2],
        });
    }

    // Parse audio streams
    while ((match = audioRegex.exec(stderr)) !== null) {
        streamDetails.push({
            type: "audio",
            codec: match[2],
            sampleRate: match[3],
        });
    }

    return streamDetails;
}

// Helper function to check if URL exists
function checkUrlExists(hlsUrl, callback) {
    const parsedUrl = url.parse(hlsUrl);
    https.get({ host: parsedUrl.host, path: parsedUrl.path }, (response) => {
        if (response.statusCode === 200) {
            callback(true);
        } else {
            callback(false);
        }
    }).on('error', () => callback(false));
}

// WebSocket server listens on the same port as the HTTP server
app.server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

app.server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

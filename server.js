const express = require("express");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");  // WebSocket library

const app = express();
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ noServer: true });  // WebSocket server

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

app.post("/download", (req, res) => {
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

        const streams = parseFFMpegStreams(stderr);  // Custom function to extract stream info from ffmpeg output

        // Send stream information back to client
        res.json({ streams });
    });
});

// Helper function to extract stream info from ffmpeg output
function parseFFMpegStreams(stderr) {
    const streamDetails = [];
    const regex = /Stream #\d+:(\d+)[^:]*: Video: (.*), (\d+)x(\d+)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) {
        streamDetails.push({
            type: "video",
            resolution: `${match[3]}x${match[4]}`,
            codec: match[2],
        });
    }
    return streamDetails;
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

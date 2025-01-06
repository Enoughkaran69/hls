const express = require("express");
const path = require("path");
const { exec } = require("child_process");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// WebSocket setup
wss.on("connection", (ws) => {
    console.log("Client connected to WebSocket");
    ws.on("close", () => {
        console.log("Client disconnected");
    });
});

// API to fetch stream information
app.post("/getStreams", (req, res) => {
    const { hlsUrl } = req.body;
    if (!hlsUrl) return res.status(400).send("HLS URL is required.");

    const command = `ffmpeg -i "${hlsUrl}"`;
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error fetching streams: ${error}`);
            return res.status(500).send("Failed to fetch stream information.");
        }

        const streams = parseStreams(stderr);
        res.json({ streams });
    });
});

// Parse ffmpeg output to extract stream information
function parseStreams(stderr) {
    const streams = [];
    const videoRegex = /Stream #\d+:(\d+).*Video: (\w+),.* (\d+)x(\d+)/g;
    const audioRegex = /Stream #\d+:(\d+).*Audio: (\w+), (\d+) Hz/g;

    let match;
    while ((match = videoRegex.exec(stderr)) !== null) {
        streams.push({
            type: "video",
            index: match[1],
            codec: match[2],
            resolution: `${match[3]}x${match[4]}`
        });
    }
    while ((match = audioRegex.exec(stderr)) !== null) {
        streams.push({
            type: "audio",
            index: match[1],
            codec: match[2],
            sampleRate: match[3]
        });
    }

    return streams;
}

// WebSocket upgrade
app.server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
app.server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

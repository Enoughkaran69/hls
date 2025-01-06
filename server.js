const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware setup
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    // Fetch the HLS playlist content (m3u8 file)
    exec(`curl -s "${hlsUrl}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error fetching HLS playlist: ${stderr || error.message}`);
            return res.status(500).send("Failed to fetch HLS playlist.");
        }

        // Parse the HLS playlist to find stream information
        const streams = parseHLSPlaylist(stdout);
        
        // Send the parsed stream data to the client
        res.json({ streams });
    });
});

// Function to parse the HLS playlist and extract stream info
const parseHLSPlaylist = (playlistContent) => {
    const streamDetails = [];
    const streamPattern = /#EXT-X-STREAM-INF:BANDWIDTH=(\d+),RESOLUTION=(\d+x\d+).*?\n([^#]+)/gi;

    let match;
    while ((match = streamPattern.exec(playlistContent)) !== null) {
        const [_, bandwidth, resolution, url] = match;
        streamDetails.push({
            bandwidth: parseInt(bandwidth),
            resolution: resolution,
            url: url.trim()
        });
    }

    return streamDetails;
};

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

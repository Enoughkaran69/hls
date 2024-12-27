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

// Handle the /download endpoint
app.post("/download", (req, res) => {
    const { hlsUrl } = req.body;

    if (!hlsUrl) {
        return res.status(400).send("HLS URL is required.");
    }

    // Create a unique file path for saving the video
    const outputPath = path.join(downloadsDir, `output_${Date.now()}.mp4`);

    // ffmpeg command to download and merge both video and audio
    const command = `ffmpeg -i "${hlsUrl}" -map 0:v:0 -map 0:a:0 -c copy -bsf:a aac_adtstoasc -f mp4 "${outputPath}"`;

    // Track progress
    let progressOutput = "";
    const ffmpegProcess = exec(command);

    // Capture ffmpeg output for progress tracking
    ffmpegProcess.stdout.on("data", (data) => {
        progressOutput += data.toString();

        // Extract the timestamp from ffmpeg output
        const match = progressOutput.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
            const time = match[1]; // Extract the timestamp
            console.log(`Progress: ${time}`);

            // Send progress to the client via WebSocket
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(time);  // Send the progress to the client
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
            // Send the video file as a response once the process is done
            res.download(outputPath, "video.mp4", (err) => {
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

// WebSocket server listens on the same port as the HTTP server
app.server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

app.server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

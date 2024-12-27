const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure a downloads directory exists
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Serve a simple homepage
app.get("/", (req, res) => {
    res.send(`
        <h1>HLS Downloader</h1>
        <form action="/download" method="post">
            <label for="hlsUrl">Enter HLS URL:</label><br>
            <input type="text" id="hlsUrl" name="hlsUrl" required><br><br>
            <button type="submit">Download</button>
        </form>
    `);
});

// Route to handle HLS downloads
app.post("/download", (req, res) => {
    const { hlsUrl } = req.body;

    if (!hlsUrl) {
        return res.status(400).send("HLS URL is required.");
    }

    const outputPath = path.join(downloadsDir, `output_${Date.now()}.mp4`);

    // ffmpeg command to download and merge HLS
    const ffmpegPath = path.join(__dirname, "bin", "ffmpeg");
    try {
    // Set the executable flag on Windows (no-op if unnecessary)
    execSync(`icacls ${ffmpegPath} /grant Everyone:(F)`);
    console.log("Permissions updated for ffmpeg.");
} catch (err) {
    console.error("Failed to set permissions for ffmpeg:", err);
}
    const command = `${ffmpegPath} -i "${hlsUrl}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${stderr}`);
            return res.status(500).send("Failed to process the HLS link.");
        }

        // Send the file as a download
        res.download(outputPath, "video.mp4", (err) => {
            if (err) {
                console.error(err);
            }

            // Clean up the file after sending
            fs.unlinkSync(outputPath);
        });
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

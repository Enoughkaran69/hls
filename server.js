const express = require("express");
const { exec } = require("child_process");
const { execSync } = require("child_process"); // Import execSync
exec("ffmpeg -version", (error, stdout, stderr) => {
    if (error) {
        console.error(`Error checking ffmpeg version: ${error}`);
        return;
    }
    console.log(`ffmpeg version info: ${stdout}`);
});


const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const ffmpegPath = '/bin/ffmpeg';  // Adjust path if needed
console.log(`Using ffmpeg at path: ${ffmpegPath}`);


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




// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

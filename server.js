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


app.post("/download", (req, res) => {
    const { hlsUrl } = req.body;

    if (!hlsUrl) {
        return res.status(400).send("HLS URL is required.");
    }

    const outputPath = path.join(downloadsDir, `output_${Date.now()}.mp4`);

    const command = `ffmpeg -i "${hlsUrl}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${stderr}`);
            return res.status(500).send("Failed to process the HLS link.");
        }

        res.download(outputPath, "video.mp4", (err) => {
            if (err) {
                console.error(err);
            }

            fs.unlinkSync(outputPath);
        });
    });
});




// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

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
        // Ensure the output directory exists
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }


  // ffmpeg command to download both audio and video from HLS stream
    const command = `ffmpeg -i "${hlsUrl}" -map 0:v:0 -map 0:a:0 -c copy -bsf:a aac_adtstoasc -f mp4 "${outputPath}"`;

     // Capture ffmpeg output
    process.stdout.on("data", (data) => {
        progressOutput += data.toString();
        
        // Extract the percentage of progress from ffmpeg output
        const match = progressOutput.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
            const time = match[1]; // Extract the timestamp
            console.log(`Progress: ${time}`);
            // You can send this progress data to the client using WebSocket, or you can implement polling.
        }
    });

    process.stderr.on("data", (data) => {
        console.error(`stderr: ${data}`);
    });

    
      process.on("close", (code) => {
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




// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

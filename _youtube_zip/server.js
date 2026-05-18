import express from "express";
import cors from "cors";
import { exec } from "child_process";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream";
import { promisify } from "util";

const pipelineAsync = promisify(pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enable CORS for all origins, with preflight support
app.use(cors());
app.options("*", cors());

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Helper: Run a command and return stdout as string (Promise)
function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout);
    });
  });
}

// /info endpoint
app.get("/info", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing id parameter" });

  try {
    const cmd = `yt-dlp --dump-json "https://youtube.com/watch?v=${id}"`;
    const stdout = await execCmd(cmd);

    const info = JSON.parse(stdout);

    const result = {
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      formats: info.formats.map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        height: f.height,
        width: f.width,
        acodec: f.acodec,
        vcodec: f.vcodec,
        filesize: f.filesize,
        tbr: f.tbr,
      })),
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch video info", details: error.toString() });
  }
});

// /stream endpoint
app.get("/stream", async (req, res) => {
  const id = req.query.id;
  const quality = req.query.quality || "best";

  if (!id) return res.status(400).json({ error: "Missing id parameter" });

  try {
    const cmd = `yt-dlp -g --format "${quality}[ext=mp4]/${quality}" "https://youtube.com/watch?v=${id}"`;
    const stdout = await execCmd(cmd);
    const url = stdout.trim().split("\n")[0];

    const range = req.headers.range;
    const headers = {};
    if (range) headers.Range = range;

    const response = await axios.get(url, {
      responseType: "stream",
      headers,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    res.status(response.status);

    if (response.headers["content-length"])
      res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-type"])
      res.setHeader("Content-Type", response.headers["content-type"]);
    if (response.headers["content-range"])
      res.setHeader("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"])
      res.setHeader("Accept-Ranges", response.headers["accept-ranges"]);

    await pipelineAsync(response.data, res);
  } catch (error) {
    if (typeof error === "object" && error.response?.status === 404) {
      res.status(404).json({ error: "Video stream not found" });
    } else {
      res.status(500).json({ error: "Failed to stream video", details: error.toString() });
    }
  }
});

// /thumb endpoint
app.get("/thumb", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id parameter");

  const thumbUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  try {
    const response = await axios.get(thumbUrl, { responseType: "stream" });

    res.setHeader("Content-Type", response.headers["content-type"] || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    await pipelineAsync(response.data, res);
  } catch {
    res.status(404).send("Thumbnail not found");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`YouTube Proxy Server running: http://localhost:${PORT}`);
});

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const { Readable } = require("stream");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());
app.set("json spaces", 2);

const PORT = process.env.PORT || 3000;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

// Extract Instagram shortcode from /p/, /reel/, /reels/, or /tv/
function extractShortcode(urlStr) {
  try {
    const url = new URL(urlStr);
    const regex = /(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
    const match = url.pathname.match(regex);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Health check & Documentation endpoint
app.get("/", (req, res) => {
  const host = req.get("x-forwarded-host") || req.get("host");
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const baseUrl = `${protocol}://${host}`;

  res.json({
    service: "Instagram Headless Media Resolver API",
    status: "online",
    endpoints: {
      resolve: {
        method: "GET | POST",
        path: "/resolve?url={INSTAGRAM_URL}",
        example: `${baseUrl}/resolve?url=https://www.instagram.com/reel/DbFXzUHoDFf/`,
        description: "Resolves videoStreamingUrl, audioStreamingUrl, videoDownloadUrl, and audioDownloadUrl."
      },
      proxy: {
        method: "GET",
        path: "/proxy?url={VIDEO_STREAM_URL}&format={video|audio}&mode={download|stream}",
        description: "Streams media directly with CORS headers. When format=audio, converts on the fly to pure MP3 via ffmpeg."
      }
    }
  });
});

// Main Media Resolver Handler
const handleResolve = async (req, res) => {
  const target = req.query.url || req.query.shortcode || req.body?.url || req.body?.shortcode;
  if (!target) {
    return res.status(400).json({ error: "Missing 'url' or 'shortcode' parameter" });
  }

  const shortcode = extractShortcode(target) || String(target).replace(/[^A-Za-z0-9_-]/g, "");
  if (!shortcode) {
    return res.status(400).json({ error: "Invalid shortcode or Instagram link" });
  }

  console.log(`[Resolver] Starting headless browser extraction for shortcode: ${shortcode}`);
  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--disable-background-networking"
      ]
    });

    const page = await browser.newPage();

    // Set realistic User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Block heavy media/styles to save memory & finish in < 2 seconds
    await page.setRequestInterception(true);
    let capturedStreamUrl = null;

    page.on("request", (interceptedReq) => {
      const type = interceptedReq.resourceType();
      const url = interceptedReq.url().toLowerCase();

      // Intercept media streaming URLs from Instagram CDN
      if (
        (url.includes("cdninstagram.com") || url.includes("fbcdn.net")) &&
        (url.includes(".mp4") || url.includes("mime_type=video") || url.includes("/v/t50.") || url.includes("/v/t0."))
      ) {
        capturedStreamUrl = interceptedReq.url();
      }

      if (type === "image" || type === "font" || type === "stylesheet") {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 12000
    });

    // Evaluate video element in the DOM
    const domVideoUrl = await page.evaluate(async () => {
      const maxAttempts = 20;
      for (let i = 0; i < maxAttempts; i++) {
        const v = document.querySelector("video");
        if (v && (v.currentSrc || v.src)) {
          const s = v.currentSrc || v.src;
          if (!s.startsWith("blob:")) return s;
        }

        const vSource = document.querySelector("video source");
        if (vSource && vSource.src && !vSource.src.startsWith("blob:")) {
          return vSource.src;
        }

        // Trigger play if needed
        const btns = document.querySelectorAll('button, div[role="button"], .PlayButton, .EmbeddedMediaImage');
        for (const btn of btns) {
          try { btn.click(); } catch(e) {}
        }

        await new Promise(r => setTimeout(r, 250));
      }
      return null;
    });

    const finalVideoUrl = capturedStreamUrl || domVideoUrl;

    if (!finalVideoUrl) {
      console.log(`[Resolver] Failed to resolve video for ${shortcode}`);
      return res.status(404).json({
        success: false,
        status: "error",
        error: "Unable to extract video stream. Post may be private or removed.",
        shortcode
      });
    }

    const host = req.get("x-forwarded-host") || req.get("host");
    const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
    const baseUrl = `${protocol}://${host}`;

    // 4 Distinct Links:
    // 1. videoStreamingUrl: direct video stream for player playback
    const videoStreamingUrl = finalVideoUrl;
    // 2. audioStreamingUrl: MP3 audio stream for inline audio player playback
    const audioStreamingUrl = `${baseUrl}/proxy?url=${encodeURIComponent(finalVideoUrl)}&format=audio&mode=stream`;
    // 3. videoDownloadUrl: direct MP4 video file download trigger
    const videoDownloadUrl = `${baseUrl}/proxy?url=${encodeURIComponent(finalVideoUrl)}`;
    // 4. audioDownloadUrl: direct MP3 audio file download trigger (converted via ffmpeg)
    const audioDownloadUrl = `${baseUrl}/proxy?url=${encodeURIComponent(finalVideoUrl)}&format=audio`;

    console.log(`[Resolver] Successfully resolved video URL for ${shortcode}!`);
    return res.json({
      success: true,
      status: "success",
      shortcode,
      videoStreamingUrl,
      audioStreamingUrl,
      videoDownloadUrl,
      audioDownloadUrl,
      // Backward-compatibility aliases
      videoStreamUrl: videoStreamingUrl,
      audioStreamUrl: audioStreamingUrl,
      videoUrl: videoStreamingUrl,
      downloadUrl: videoDownloadUrl,
      audioUrl: audioDownloadUrl
    });

  } catch (err) {
    console.error(`[Resolver] Error resolving ${shortcode}:`, err.message);
    return res.status(500).json({ success: false, status: "error", error: err.message, shortcode });
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }
};

// Map resolver endpoints
app.get("/resolve", handleResolve);
app.post("/resolve", handleResolve);
app.get("/download", handleResolve);
app.post("/download", handleResolve);
app.get("/api/download", handleResolve);
app.post("/api/download", handleResolve);

// Proxy stream to bypass Instagram CDN CORS & trigger instant download (MP4 video or MP3 audio)
const handleProxy = async (req, res) => {
  const mediaUrl = req.query.url;
  const format = req.query.format || req.query.as;
  const mode = req.query.mode;

  if (!mediaUrl) {
    return res.status(400).send("Missing 'url' query parameter");
  }

  const isAudio = format === "audio" || format === "mp3";
  const isStream = mode === "stream" || mode === "inline";

  // If format is audio, use ffmpeg to extract and convert audio to real MP3
  if (isAudio) {
    console.log("[Proxy] Converting media to pure MP3 via ffmpeg...");

    const disposition = isStream ? "inline" : 'attachment; filename="instagram_audio.mp3"';

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Content-Type", "audio/mpeg");

    let ffmpegProcess = null;

    try {
      ffmpegProcess = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-headers", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\nReferer: https://www.instagram.com/\r\n",
        "-i", mediaUrl,
        "-vn",
        "-acodec", "libmp3lame",
        "-b:a", "192k",
        "-f", "mp3",
        "pipe:1"
      ]);

      ffmpegProcess.stdout.pipe(res);

      ffmpegProcess.stderr.on("data", (chunk) => {
        console.error(`[FFmpeg error] ${chunk}`);
      });

      ffmpegProcess.on("error", (err) => {
        console.error("[FFmpeg spawn error]:", err.message);
        if (!res.headersSent) {
          res.status(500).send(`Audio conversion failed: ${err.message}`);
        }
      });

      res.on("close", () => {
        try {
          if (ffmpegProcess) ffmpegProcess.kill("SIGKILL");
        } catch {}
      });

      return;
    } catch (ffmpegErr) {
      console.error("[Proxy] FFmpeg exception:", ffmpegErr);
      if (!res.headersSent) {
        return res.status(500).send("Failed to start audio conversion");
      }
      return;
    }
  }

  // Otherwise, stream MP4 video
  try {
    const cdnRes = await fetch(mediaUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.instagram.com/",
        "Accept": "*/*"
      }
    });

    if (!cdnRes.ok) {
      return res.status(cdnRes.status).send(`Failed to stream media from CDN: HTTP ${cdnRes.status}`);
    }

    const disposition = isStream ? "inline" : 'attachment; filename="instagram_video.mp4"';

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Content-Type", cdnRes.headers.get("content-type") || "video/mp4");

    const length = cdnRes.headers.get("content-length");
    if (length) {
      res.setHeader("Content-Length", length);
    }

    const nodeStream = Readable.fromWeb(cdnRes.body);

    nodeStream.on("error", (err) => {
      console.error("[Proxy] Streaming error:", err.message);
      if (!res.headersSent) {
        res.status(500).send("Stream error");
      }
    });

    res.on("close", () => {
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  } catch (err) {
    console.error("[Proxy] Fetch error:", err.message);
    if (!res.headersSent) {
      res.status(500).send(`Error streaming media: ${err.message}`);
    }
  }
};

app.get("/proxy", handleProxy);
app.get("/api/proxy", handleProxy);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Instagram Headless Resolver running on port ${PORT}`);
});

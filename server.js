const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");

const app = express();
app.use(cors());
app.use(express.json());

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

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Instagram Headless Resolver (Render)",
    usage: "/resolve?shortcode=XYZ or /resolve?url=https://www.instagram.com/reel/XYZ/"
  });
});

// Main Resolver endpoint: launches headless Chromium to resolve the embed page like an Android WebView
app.get("/resolve", async (req, res) => {
  const target = req.query.url || req.query.shortcode;
  if (!target) {
    return res.status(400).json({ error: "Missing 'url' or 'shortcode' query parameter" });
  }

  const shortcode = extractShortcode(target) || target.replace(/[^A-Za-z0-9_-]/g, "");
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
    
    // Set realistic mobile/desktop User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Block heavy media/styles to save memory & finish in < 2 seconds
    await page.setRequestInterception(true);
    let capturedStreamUrl = null;

    page.on("request", (req) => {
      const type = req.resourceType();
      const url = req.url().toLowerCase();

      // Intercept any media streaming URLs
      if ((url.includes("cdninstagram.com") || url.includes("fbcdn.net")) &&
          (url.includes(".mp4") || url.includes("mime_type=video") || url.includes("/v/t50.") || url.includes("/v/t0."))) {
        capturedStreamUrl = req.url();
      }

      if (type === "image" || type === "font" || type === "stylesheet") {
        req.abort();
      } else {
        req.continue();
      }
    });

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 12000
    });

    // Evaluate the same logic as the Android WebView
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

        // Click play/consent buttons if needed
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
        error: "Unable to extract video stream. Post may be private or removed.",
        shortcode
      });
    }

    console.log(`[Resolver] Successfully resolved video URL for ${shortcode}!`);
    return res.json({
      success: true,
      shortcode,
      videoUrl: finalVideoUrl
    });

  } catch (err) {
    console.error(`[Resolver] Error resolving ${shortcode}:`, err.message);
    return res.status(500).json({ success: false, error: err.message, shortcode });
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Instagram Headless Resolver running on port ${PORT}`);
});

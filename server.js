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

// Parse cookie string into Puppeteer cookie objects
function parseCookies(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr
    .split(";")
    .map((pair) => {
      const parts = pair.trim().split("=");
      if (!parts[0]) return null;
      return {
        name: parts[0].trim(),
        value: parts.slice(1).join("=").trim(),
        domain: ".instagram.com",
        path: "/",
      };
    })
    .filter(Boolean);
}

// Global browser instance reuse for sub-second page creation
let sharedBrowser = null;
async function getBrowser() {
  if (sharedBrowser && sharedBrowser.connected) {
    return sharedBrowser;
  }
  sharedBrowser = await puppeteer.launch({
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
      "--disable-background-networking",
    ],
  });
  sharedBrowser.on("disconnected", () => {
    sharedBrowser = null;
  });
  return sharedBrowser;
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Instagram Headless Resolver (Render)",
    usage: "/resolve?shortcode=XYZ or /resolve?url=https://www.instagram.com/reel/XYZ/",
  });
});

// Main Resolver endpoint
app.get("/resolve", async (req, res) => {
  const target = req.query.url || req.query.shortcode;
  if (!target) {
    return res.status(400).json({ error: "Missing 'url' or 'shortcode' query parameter" });
  }

  const shortcode = extractShortcode(target) || target.replace(/[^A-Za-z0-9_-]/g, "");
  if (!shortcode) {
    return res.status(400).json({ error: "Invalid shortcode or Instagram link" });
  }

  console.log(`[Resolver] Headless extraction started for shortcode: ${shortcode}`);

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Realistic desktop User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    // Inject session cookies if provided (via headers, query, or env)
    const rawCookie =
      req.headers["cookie"] ||
      req.headers["x-instagram-cookie"] ||
      req.query.cookie ||
      process.env.INSTAGRAM_COOKIE;

    if (rawCookie) {
      const cookies = parseCookies(rawCookie);
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    }

    let capturedStreamUrl = null;
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      const type = request.resourceType();
      const url = request.url().toLowerCase();

      // Intercept video streams immediately
      if (
        (url.includes("cdninstagram.com") || url.includes("fbcdn.net")) &&
        (url.includes(".mp4") ||
          url.includes("mime_type=video") ||
          url.includes("/v/t50.") ||
          url.includes("/v/t0.") ||
          url.includes("/v/t60."))
      ) {
        capturedStreamUrl = request.url();
      }

      if (type === "image" || type === "font" || type === "stylesheet") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Extract query parameters (like ?stkn=...) from the original URL
    let queryString = "";
    if (typeof target === "string" && target.includes("?")) {
      queryString = target.substring(target.indexOf("?"));
    }

    // Attempt 1: Embed URL with original query string (preserves ?stkn= token)
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/${queryString}`;
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    // Check for DOM video or wait up to 4 seconds
    let domVideoUrl = await page.evaluate(async () => {
      for (let i = 0; i < 16; i++) {
        const v = document.querySelector("video");
        if (v && (v.currentSrc || v.src)) {
          const s = v.currentSrc || v.src;
          if (!s.startsWith("blob:")) return s;
        }

        const vSource = document.querySelector("video source");
        if (vSource && vSource.src && !vSource.src.startsWith("blob:")) {
          return vSource.src;
        }

        const btns = document.querySelectorAll('button, div[role="button"], .PlayButton, .EmbeddedMediaImage');
        for (const btn of btns) {
          try { btn.click(); } catch (e) {}
        }

        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    });

    let finalVideoUrl = capturedStreamUrl || domVideoUrl;

    // Attempt 2: If embed failed, navigate directly to the post/reel page
    if (!finalVideoUrl && target.startsWith("http")) {
      console.log(`[Resolver] Embed failed, trying direct reel URL: ${target}`);
      await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });

      domVideoUrl = await page.evaluate(async () => {
        for (let i = 0; i < 12; i++) {
          const v = document.querySelector("video");
          if (v && (v.currentSrc || v.src)) {
            const s = v.currentSrc || v.src;
            if (!s.startsWith("blob:")) return s;
          }
          const vSource = document.querySelector("video source");
          if (vSource && vSource.src && !vSource.src.startsWith("blob:")) {
            return vSource.src;
          }
          const btns = document.querySelectorAll('button, div[role="button"]');
          for (const btn of btns) {
            try { btn.click(); } catch (e) {}
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      });

      finalVideoUrl = capturedStreamUrl || domVideoUrl;
    }

    if (!finalVideoUrl) {
      console.log(`[Resolver] Failed to resolve video for ${shortcode}`);
      return res.status(404).json({
        success: false,
        error: "Unable to extract video stream. Post may be private or removed.",
        shortcode,
      });
    }

    console.log(`[Resolver] Successfully resolved video URL for ${shortcode}!`);
    return res.json({
      success: true,
      shortcode,
      videoUrl: finalVideoUrl,
    });
  } catch (err) {
    console.error(`[Resolver] Error resolving ${shortcode}:`, err.message);
    return res.status(500).json({ success: false, error: err.message, shortcode });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Instagram Headless Resolver running on port ${PORT}`);
});

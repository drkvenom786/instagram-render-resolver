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

// Global persistent browser instance to eliminate cold-launch overhead
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
      "--disable-blink-features=AutomationControlled",
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
    service: "Instagram Headless Resolver (Render - 100% Cookie-Free)",
    usage: "/resolve?shortcode=XYZ or /resolve?url=https://www.instagram.com/reel/XYZ/",
  });
});

// Main Resolver endpoint: 100% Anonymous & Cookie-Free
app.get("/resolve", async (req, res) => {
  const target = req.query.url || req.query.shortcode;
  if (!target) {
    return res.status(400).json({ error: "Missing 'url' or 'shortcode' query parameter" });
  }

  const shortcode = extractShortcode(target) || target.replace(/[^A-Za-z0-9_-]/g, "");
  if (!shortcode) {
    return res.status(400).json({ error: "Invalid shortcode or Instagram link" });
  }

  console.log(`[Resolver] Cookie-free extraction initiated for shortcode: ${shortcode}`);

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set standard desktop viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Apply stealth script to bypass bot detection without needing cookies
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
    });

    // Realistic desktop browser User-Agent & Headers
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });

    let capturedStreamUrl = null;
    await page.setRequestInterception(true);

    page.on("request", (request) => {
      const type = request.resourceType();
      const url = request.url().toLowerCase();

      // Intercept video streams from Instagram/Meta CDNs
      if (
        (url.includes("cdninstagram.com") || url.includes("fbcdn.net")) &&
        (url.includes(".mp4") ||
          url.includes("mime_type=video") ||
          url.includes("/v/t50.") ||
          url.includes("/v/t0.") ||
          url.includes("/v/t60.") ||
          url.includes("bytestart="))
      ) {
        capturedStreamUrl = request.url();
      }

      // Abort heavy unneeded assets to keep RAM usage low on Render
      if (type === "image" || type === "font" || type === "stylesheet") {
        request.abort();
      } else {
        request.continue();
      }
    });

    page.on("response", (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.includes("video/mp4") ||
        (url.includes(".mp4") && (url.includes("cdninstagram.com") || url.includes("fbcdn.net")))
      ) {
        capturedStreamUrl = url;
      }
    });

    // Extract query tokens (like ?stkn=...) if present
    let queryString = "";
    if (typeof target === "string" && target.includes("?")) {
      queryString = target.substring(target.indexOf("?"));
    }

    // Step 1: Navigate to Instagram embed page (publicly accessible without login or cookies)
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/${queryString}`;
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    // Check for DOM video element and trigger playback buttons
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

        // Click play buttons, video overlay, or cookie consent banners if present
        const btns = document.querySelectorAll(
          'button, div[role="button"], .PlayButton, .EmbeddedMediaImage, .Video, .Embed, a[role="button"]'
        );
        for (const btn of btns) {
          try {
            btn.click();
          } catch (e) {}
        }

        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    });

    let finalVideoUrl = capturedStreamUrl || domVideoUrl;

    // Step 2: Check raw HTML script content if DOM hasn't attached video yet
    if (!finalVideoUrl) {
      const pageHtml = await page.content();
      const mp4Matches = pageHtml.match(
        /https:\/\/[^"'\s\\]*(?:cdninstagram\.com|fbcdn\.net)[^"'\s\\]*\.mp4[^"'\s\\]*/g
      );
      if (mp4Matches && mp4Matches.length > 0) {
        finalVideoUrl = mp4Matches[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
      }
    }

    // Step 3: If embed failed, navigate to the direct reel/post URL
    if (!finalVideoUrl && target.startsWith("http")) {
      console.log(`[Resolver] Embed unresolved, falling back to direct URL: ${target}`);
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
            try {
              btn.click();
            } catch (e) {}
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return null;
      });

      finalVideoUrl = capturedStreamUrl || domVideoUrl;

      if (!finalVideoUrl) {
        const pageHtml = await page.content();
        const mp4Matches = pageHtml.match(
          /https:\/\/[^"'\s\\]*(?:cdninstagram\.com|fbcdn\.net)[^"'\s\\]*\.mp4[^"'\s\\]*/g
        );
        if (mp4Matches && mp4Matches.length > 0) {
          finalVideoUrl = mp4Matches[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
        }
      }
    }

    if (!finalVideoUrl) {
      console.log(`[Resolver] Failed to resolve video for ${shortcode}`);
      return res.status(404).json({
        success: false,
        error: "Unable to extract video stream. Post may be private or removed.",
        shortcode,
      });
    }

    console.log(`[Resolver] Successfully resolved video URL for ${shortcode} (Cookie-free)!`);
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

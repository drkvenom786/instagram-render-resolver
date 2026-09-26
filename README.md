# Instagram Headless Chromium Resolver (Render Service)

This service runs a lightweight headless Chromium instance (using Puppeteer) to resolve Instagram reels and posts using the exact same DOM & network interception strategy as an Android WebView.

---

## 🚀 How to Deploy on Render (100% Free)

### Step 1: Push to GitHub
Ensure the `render-service` folder is committed to your repository (`drkvenom786/instagram-downloader-api`).

### Step 2: Create a Web Service on Render
1. Log in to [dashboard.render.com](https://dashboard.render.com/).
2. Click **New +** -> **Web Service**.
3. Select your repository: **`drkvenom786/instagram-downloader-api`**.
4. Configure the settings:
   - **Name:** `instagram-resolver` (or your choice)
   - **Root Directory:** `render-service`
   - **Environment / Runtime:** `Docker` (Render will use `Dockerfile` automatically)
   - **Instance Type:** `Free` ($0/month)
5. Click **Create Web Service**.

Render will build the Docker container and provide a public URL like:
`https://instagram-resolver.onrender.com`

---

## 🔗 Connect to Your Cloudflare Worker

Once your Render service is live:

1. Open `wrangler.toml` in your Worker project and add your Render URL under `[vars]`:
   ```toml
   [vars]
   RENDER_SERVICE_URL = "https://instagram-resolver.onrender.com"
   ```

2. Redeploy the Worker:
   ```bash
   npx wrangler deploy
   ```

### ⚡ How It Works Together
```
Client / Browser / App
         │
         ▼
[Cloudflare Worker] (/api/download?url=...)
         │
         ├─► 1. Tries Fast Serverless GraphQL (Instant)
         │
         └─► 2. If blocked, forwards to [Render Puppeteer Service]
                  • Opens headless Chrome
                  • Renders embed page like a WebView
                  • Returns .mp4 stream to Worker
```

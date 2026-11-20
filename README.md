# Media Finder PWA

Bilingual (Arabic/English) Progressive Web App for discovering image and video references in webpages. Responsive on phones and desktop; installable from supported browsers when served over HTTPS.

## Run locally
- Node.js 20+
- `npm install`
- `npm start`
- Open `http://localhost:3000`

PWA installation and service-worker caching require HTTPS in production (localhost is also treated as secure by browsers).

## Deploy to Render
1. Push the contents of this folder to a GitHub repository.
2. Create a Render Web Service connected to that repository.
3. Keep the included `render.yaml` settings (`npm install`, `npm start`, Node 20).
4. Open the HTTPS URL on your phone and use the browser's **Install app / Add to Home Screen** action. The in-app install button appears when the browser exposes the install prompt.

## Access modes and important limitations

### 1. Public URL scan
The backend fetches public HTTP(S) HTML and extracts media references from image/video tags, lazy-loading attributes, `srcset`, Open Graph/Twitter metadata and JSON-LD.

### 2. Authenticated page import (local processing)
If you can access a page after signing in, save that page as an HTML file from the browser and import the file in Media Finder. The HTML is parsed locally in your browser; it is not uploaded to this server. Enter the original page URL in the optional base URL field so relative media paths can be resolved.

This import method is best-effort: some browsers save only the current DOM or a simplified page; scripts, dynamically loaded resources, cross-origin frames, and media URLs requiring the original session may be absent or may not open outside that session. The PWA cannot read cookies or login sessions belonging to other websites. It does not ask for passwords, collect cookies, or forward session tokens.

### What is not supported
- Universal authenticated scanning across arbitrary websites. Official OAuth/API integrations would need to be implemented separately for each supported service.
- Reading another site's browser cookies or reusing its login session from the PWA.
- Bypassing login controls, paywalls, anti-bot protections, DRM, CORS, or access restrictions.
- Guaranteed extraction of JavaScript-rendered media, protected streams, HLS/DASH segment merging, or encrypted media.
- Guaranteed video quality/dimensions unless the source exposes those details.

Downloads through the server proxy are for direct public media URLs only (up to 80 MB). Imported HTML results are opened directly from the browser and are not proxied, because they may depend on a signed URL or an authenticated browser session.

## Production hardening
The server now applies a per-IP request limit (30 API requests/minute), caps HTML and media downloads, follows only a small number of redirects after re-validating each destination, rejects private/reserved IP ranges, pins outbound requests to a DNS-resolved public IP, and applies request timeouts. The in-memory rate limiter is per process and is not a substitute for a shared production quota on multi-instance deployments. Add authentication/quotas and operational monitoring before offering this as a high-volume public service. Review target-site terms and copyright requirements.

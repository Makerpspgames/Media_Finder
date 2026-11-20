# Media Finder PWA — Cloudflare Workers Edition

Bilingual (Arabic/English) Progressive Web App for discovering image and video references in public webpages. Responsive on phones and desktop; installable from supported browsers over HTTPS.

## Deploy on Cloudflare (no credit card required for the Free plan)

1. Create a free Cloudflare account: https://dash.cloudflare.com/sign-up
2. Create a GitHub repository and upload the contents of this folder (not the parent folder).
3. In Cloudflare Dashboard, open **Workers & Pages** → **Create** → **Import a repository**.
4. Select the GitHub repository.
5. Configure the project as a **Worker** with these settings:
   - Build command: `npm install`
   - Deploy command: `npx wrangler deploy`
   - Root directory: `/` (or the folder containing `wrangler.toml`)
6. Deploy. The `wrangler.toml` file configures the Worker entry point and the `public` static-assets directory.
7. Open the generated `*.workers.dev` HTTPS URL. Use the browser's **Install app / Add to Home Screen** action.

If the dashboard offers a direct **Workers & Pages → Create application → Workers → Import a repository** flow, use that and retain the repository's `wrangler.toml` settings. The dashboard labels can change over time.

## Local development

- Node.js 20+
- `npm install`
- `npm run dev`
- Open the local URL printed by Wrangler.

## API

- `GET /api/health` — health check.
- `POST /api/scan` — JSON body `{ "url": "https://example.com" }`; fetches public HTML and extracts media references.
- `GET /api/thumb?url=...` — serves a public image inline (up to 10 MB) for result thumbnails. HLS/DASH manifests are not supported.
- `GET /api/proxy?url=...` — downloads direct public media files up to 80 MB. HLS/DASH manifests are not downloaded.

## Access modes and limitations

### Public URL scan
The Worker fetches public HTTP(S) HTML and extracts media references from image/video tags, lazy-loading attributes, `srcset`, Open Graph/Twitter metadata and JSON-LD. It does not execute page JavaScript.

Thumbnails load directly from the source host first. When a host blocks cross-site embedding (hotlink protection), the thumbnail automatically retries through `/api/thumb`, the same server-side fetch path used for downloads.

### Authenticated page import (local processing)
If you can access a page after signing in, save that page as an HTML file from the browser and import it in Media Finder. The HTML is parsed locally in the browser; it is not uploaded to Cloudflare. Enter the original page URL in the optional base URL field so relative media paths can be resolved. Some browsers save only a simplified DOM; scripts, dynamically loaded resources, cross-origin frames, and media URLs requiring the original session may be absent or may not open outside that session.

The PWA cannot read cookies or login sessions belonging to other websites. It does not ask for passwords, collect cookies, or forward session tokens.

### Not supported
- Universal authenticated scanning across arbitrary websites.
- Reading another site's browser cookies or reusing its login session from the PWA.
- Bypassing login controls, paywalls, anti-bot protections, DRM, CORS, or access restrictions.
- Guaranteed extraction of JavaScript-rendered media, HLS/DASH segment merging, or encrypted media.
- Guaranteed video quality/dimensions unless the source exposes those details.

## Security and platform notes

- API fetches accept HTTP(S) hostnames only; IP-literal hosts, localhost and common internal hostnames are rejected.
- Redirects are manual, limited to three, and every redirect destination is revalidated.
- HTML is capped at 5 MB, direct media downloads at 80 MB, and requests time out after 15 seconds.
- Cloudflare Workers handles outbound fetch networking. Unlike the former Node server, this Worker cannot pin a DNS lookup result to a socket; do not treat hostname checks as a substitute for Cloudflare's network-level egress protections. Do not add arbitrary internal service bindings or secrets to this public scanner.
- This initial edition does not implement a persistent per-user rate limiter. Cloudflare Free plan usage limits apply; add a Cloudflare Rate Limiting rule or Turnstile before promoting the service publicly.
- Browser caching is limited to the app shell; API responses are not cached, except thumbnails, which may be kept privately in the visitor's own browser for up to one hour.

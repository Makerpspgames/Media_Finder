# Media Finder

Bilingual Arabic/English media discovery web app.

## Run locally
Requires Node.js 20+. Run `npm install`, then `npm start`, then open http://localhost:3000.

## Deploy
Push this folder's contents to GitHub. On Render, create a Web Service connected to the repository. The included render.yaml specifies `npm install` and `npm start`.

## Important limits
Best-effort extraction from public HTML, ordinary media tags, srcset, Open Graph/Twitter metadata and JSON-LD. It cannot bypass login walls, paywalls, DRM, anti-bot systems, private content or access restrictions. JavaScript-rendered media not present in the returned HTML may be missed. HLS/DASH manifests are identified but not merged or decrypted. Quality/dimensions are shown only when exposed by the page. Downloads are limited to direct files up to 80 MB. Respect copyright and site terms.

Security note: this starter validates HTTP(S), rejects private/local IPs, limits payload sizes and timeouts. Before public production use, add authentication, rate limiting, quotas, stronger DNS-rebinding protection and monitoring.

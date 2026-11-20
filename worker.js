const MAX_HTML = 5 * 1024 * 1024;
const MAX_FILE = 80 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

// Best-effort per-client rate limiting. cf-connecting-ip is set by the Cloudflare
// edge from the real connection and cannot be spoofed by the caller; locally the
// header is absent and all traffic shares one 'unknown' bucket. Buckets live in
// isolate memory, so limits are per isolate instance, not globally exact.
// Separate budgets per endpoint: previews load directly from source hosts, so the
// proxy budget is only spent by user-initiated downloads.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = { scan: 20, proxy: 100 };
const rateBuckets = new Map();
function rateLimited(request, kind) {
  const key = kind + ':' + (request.headers.get('cf-connecting-ip') || 'unknown');
  const now = Date.now();
  if (rateBuckets.size > 10000) rateBuckets.clear();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) { bucket = { start: now, count: 0 }; rateBuckets.set(key, bucket); }
  bucket.count += 1;
  return bucket.count > RATE_LIMITS[kind];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

function blockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // Reject IP literals altogether. This also blocks IPv4, IPv6 and mapped IPv4 literals.
  if (/^[0-9.]+$/.test(h) || h.includes(':')) return true;
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.test') || h === 'metadata.google.internal') return true;
  if (!h.includes('.')) return true;
  return false;
}

function validateURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs are supported');
  if (blockedHost(url.hostname)) throw new Error('Local, internal and IP-literal hosts are blocked');
  return url;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Resource exceeds size limit');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Resource exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function fetchPublic(rawURL, maxBytes, accept = '*/*') {
  let current = validateURL(rawURL);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('Request timed out'), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'MediaFinder/1.2 (+public webpage media discovery)', 'accept': accept }
      });
    } catch (error) {
      clearTimeout(timer);
      if (error && error.name === 'AbortError') throw new Error('Request timed out');
      throw new Error('Unable to fetch the public URL');
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without a destination');
      if (i === MAX_REDIRECTS) throw new Error('Too many redirects');
      current = validateURL(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const bytes = await readLimited(response, maxBytes);
    return { bytes, headers: response.headers, url: current.href };
  }
  throw new Error('Unable to fetch resource');
}

function absoluteURL(value, base) {
  if (!value || /^(data|blob|javascript):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function addUnique(map, item) { if (item.url && !map.has(item.url)) map.set(item.url, item); }
function parseSrcset(value, base) {
  return String(value || '').split(',').map(part => {
    const match = part.trim().match(/^(\S+)(?:\s+(\S+))?$/);
    return match ? { url: absoluteURL(match[1], base), descriptor: match[2] || '' } : null;
  }).filter(item => item && item.url);
}

async function extractMedia(html, baseURL) {
  const images = new Map();
  const videos = new Map();
  const meta = [];
  const jsonScripts = [];
  let title = '';
  let currentJSON = '';
  const rewriter = new HTMLRewriter()
    .on('title', { text(text) { title += text.text; } })
    .on('img', { element(el) {
      const url = absoluteURL(el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-lazy-src'), baseURL);
      if (url) addUnique(images, { url, alt: el.getAttribute('alt') || '', width: el.getAttribute('width') || null, height: el.getAttribute('height') || null, source: 'img' });
      parseSrcset(el.getAttribute('srcset') || el.getAttribute('data-srcset'), baseURL).forEach(item => addUnique(images, { ...item, source: 'srcset' }));
    }})
    .on('picture source', { element(el) { parseSrcset(el.getAttribute('srcset'), baseURL).forEach(item => addUnique(images, { ...item, source: 'picture' })); }})
    .on('video', { element(el) {
      const poster = absoluteURL(el.getAttribute('poster'), baseURL);
      const url = absoluteURL(el.getAttribute('src'), baseURL);
      if (url) addUnique(videos, { url, poster, quality: el.getAttribute('data-quality') || '', type: el.getAttribute('type') || '', source: 'video' });
    }})
    .on('video source', { element(el) {
      const url = absoluteURL(el.getAttribute('src'), baseURL);
      if (url) addUnique(videos, { url, poster: null, quality: el.getAttribute('label') || el.getAttribute('data-quality') || '', type: el.getAttribute('type') || '', source: 'source' });
    }})
    .on('meta', { element(el) {
      const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
      const content = el.getAttribute('content');
      if (content) meta.push({ key, content });
    }})
    .on('script[type="application/ld+json"]', {
      element() { currentJSON = ''; },
      text(text) { currentJSON += text.text; if (text.lastInTextNode) { jsonScripts.push(currentJSON); currentJSON = ''; } }
    });
  // HTMLRewriter consumes the response stream; transformed HTML is intentionally discarded.
  await rewriter.transform(new Response(html)).arrayBuffer();
  for (const item of meta) {
    if (['og:image', 'twitter:image', 'og:image:secure_url'].includes(item.key)) {
      const url = absoluteURL(item.content, baseURL); if (url) addUnique(images, { url, source: 'metadata' });
    }
    if (['og:video', 'og:video:url', 'twitter:player:stream'].includes(item.key)) {
      const url = absoluteURL(item.content, baseURL); if (url) addUnique(videos, { url, source: 'metadata' });
    }
  }
  for (const raw of jsonScripts) {
    try {
      const walk = object => {
        if (!object || typeof object !== 'object') return;
        if (Array.isArray(object)) { object.forEach(walk); return; }
        const values = Array.isArray(object.image) ? object.image : [object.image];
        values.forEach(value => {
          const url = absoluteURL(typeof value === 'string' ? value : value && value.url, baseURL);
          if (url) addUnique(images, { url, source: 'JSON-LD' });
        });
        const videoURL = absoluteURL(object.contentUrl || object.embedUrl, baseURL);
        if (videoURL && /video|mp4|m3u8|webm/i.test(`${object['@type'] || ''} ${videoURL}`)) addUnique(videos, { url: videoURL, source: 'JSON-LD' });
        Object.values(object).forEach(walk);
      };
      walk(JSON.parse(raw));
    } catch { /* Ignore malformed JSON-LD. */ }
  }
  return { page: { url: baseURL, title: title.trim() || baseURL }, images: [...images.values()], videos: [...videos.values()], counts: { images: images.size, videos: videos.size } };
}

async function handleScan(request) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }
  if (!body || typeof body.url !== 'string' || body.url.length > 2048) return json({ ok: false, error: 'A valid URL is required' }, 400);
  try {
    const result = await fetchPublic(body.url, MAX_HTML, 'text/html,application/xhtml+xml');
    const contentType = result.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('URL did not return an HTML page');
    const html = new TextDecoder('utf-8').decode(result.bytes);
    return json({ ok: true, ...await extractMedia(html, result.url) });
  } catch (error) { return json({ ok: false, error: error.message || 'Scan failed' }, 400); }
}

async function handleProxy(url) {
  const rawURL = url.searchParams.get('url') || '';
  if (!rawURL || rawURL.length > 2048) return new Response('A valid URL is required', { status: 400 });
  if (/\.(m3u8|mpd)(?:\?|$)/i.test(rawURL)) return new Response('Streaming manifests are not downloadable', { status: 400 });
  try {
    const result = await fetchPublic(rawURL, MAX_FILE);
    const contentType = (result.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    const pathname = new URL(result.url).pathname;
    let filename = pathname.split('/').pop() || 'media-file';
    filename = filename.replace(/[\r\n"\\]/g, '_').slice(0, 180);
    return new Response(result.bytes, { headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    }});
  } catch (error) { return new Response(error.message || 'Download failed', { status: 400 }); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'media-finder-cloudflare' });
    if (url.pathname === '/api/scan' && request.method === 'POST') { if (rateLimited(request, 'scan')) return json({ ok: false, error: 'Too many scans. Please wait a few minutes and try again.' }, 429); return handleScan(request); }
    if (url.pathname === '/api/proxy' && request.method === 'GET') { if (rateLimited(request, 'proxy')) return new Response('Too many downloads. Please wait a few minutes and try again.', { status: 429 }); return handleProxy(url); }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};

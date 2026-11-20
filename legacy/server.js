'use strict';

const express = require('express');
const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_HTML = 5 * 1024 * 1024;
const MAX_FILE = 80 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates TLS in front of the Node service.
app.use(express.json({ limit: '16kb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// Small in-memory limit. For multi-instance deployments, use a shared rate limiter.
const rateBuckets = new Map();
app.use('/api/', (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= 60_000) bucket = { start: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > 30) return res.status(429).json({ ok: false, error: 'Too many requests. Try again in one minute.' });
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.start > 120_000) rateBuckets.delete(k);
  }
  next();
});

function isPublicIP(address) {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}

async function resolvePublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local and internal hosts are blocked');
  }
  if (net.isIP(host)) {
    if (!isPublicIP(host)) throw new Error('Private or reserved IP addresses are blocked');
    return [{ address: host, family: net.isIP(host) }];
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicIP(record.address))) {
    throw new Error('Host resolves to a private or reserved address');
  }
  return records;
}

async function validateURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs are supported');
  }
  await resolvePublicHost(url.hostname);
  return url;
}

function requestOnce(url, limit, accept) {
  return new Promise(async (resolve, reject) => {
    let records;
    try { records = await resolvePublicHost(url.hostname); } catch (error) { reject(error); return; }
    const selected = records[0];
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finishError = error => { if (!settled) { settled = true; reject(error); } };
    const req = transport.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'MediaFinder/1.1 (+public webpage media discovery)',
        Accept: accept || '*/*',
        'Accept-Encoding': 'identity'
      },
      timeout: TIMEOUT_MS,
      // Pin the connection to the address that was checked above (DNS-rebinding mitigation).
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return finishError(new Error('Redirect without a destination'));
        if (!settled) { settled = true; resolve({ redirect: location, status }); }
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return finishError(new Error(`Source returned HTTP ${status}`));
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > limit) {
        response.destroy();
        return finishError(new Error('Resource exceeds size limit'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          response.destroy(new Error('Resource exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ buffer: Buffer.concat(chunks), headers: response.headers, status });
        }
      });
      response.on('error', finishError);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', finishError);
    req.end();
  });
}

async function fetchLimited(rawURL, limit, accept = '*/*') {
  let current = await validateURL(rawURL);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const result = await requestOnce(current, limit, accept);
    if (!result.redirect) return { ...result, url: current.href };
    if (i === MAX_REDIRECTS) throw new Error('Too many redirects');
    current = await validateURL(new URL(result.redirect, current).href);
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

function addUnique(map, item) {
  if (item.url && !map.has(item.url)) map.set(item.url, item);
}

function parseSrcset(value, base) {
  return String(value || '').split(',').map(part => {
    const match = part.trim().match(/^(\S+)(?:\s+(\S+))?$/);
    return match ? { url: absoluteURL(match[1], base), descriptor: match[2] || '' } : null;
  }).filter(item => item && item.url);
}

function extractMedia(html, baseURL) {
  const $ = cheerio.load(html);
  const images = new Map();
  const videos = new Map();

  $('img').each((_, element) => {
    const el = $(element);
    const url = absoluteURL(el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src'), baseURL);
    if (url) addUnique(images, { url, alt: el.attr('alt') || '', width: el.attr('width') || null, height: el.attr('height') || null, source: 'img' });
    parseSrcset(el.attr('srcset') || el.attr('data-srcset'), baseURL).forEach(item => addUnique(images, { ...item, source: 'srcset' }));
  });

  $('picture source').each((_, element) => parseSrcset($(element).attr('srcset'), baseURL)
    .forEach(item => addUnique(images, { ...item, source: 'picture' })));

  $('video').each((_, element) => {
    const el = $(element);
    const poster = absoluteURL(el.attr('poster'), baseURL);
    const videoURL = absoluteURL(el.attr('src'), baseURL);
    if (videoURL) addUnique(videos, { url: videoURL, poster, quality: el.attr('data-quality') || '', type: el.attr('type') || '', source: 'video' });
    el.find('source').each((__, source) => {
      const item = $(source);
      const url = absoluteURL(item.attr('src'), baseURL);
      if (url) addUnique(videos, { url, poster, quality: item.attr('label') || item.attr('data-quality') || '', type: item.attr('type') || '', source: 'source' });
    });
  });

  $('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:secure_url"]').each((_, element) => {
    const url = absoluteURL($(element).attr('content'), baseURL);
    if (url) addUnique(images, { url, source: 'metadata' });
  });
  $('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"]').each((_, element) => {
    const url = absoluteURL($(element).attr('content'), baseURL);
    if (url) addUnique(videos, { url, source: 'metadata' });
  });

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const walk = object => {
        if (!object || typeof object !== 'object') return;
        if (Array.isArray(object)) { object.forEach(walk); return; }
        const imageValues = Array.isArray(object.image) ? object.image : [object.image];
        imageValues.forEach(value => {
          const url = absoluteURL(typeof value === 'string' ? value : value && value.url, baseURL);
          if (url) addUnique(images, { url, source: 'JSON-LD' });
        });
        const videoValue = object.contentUrl || object.embedUrl;
        const videoURL = absoluteURL(videoValue, baseURL);
        if (videoURL && /video|mp4|m3u8|webm/i.test(`${object['@type'] || ''} ${videoURL}`)) {
          addUnique(videos, { url: videoURL, source: 'JSON-LD' });
        }
        Object.values(object).forEach(walk);
      };
      walk(JSON.parse($(element).text()));
    } catch { /* Ignore malformed JSON-LD blocks. */ }
  });

  return { page: { url: baseURL, title: $('title').text().trim() || baseURL }, images: [...images.values()], videos: [...videos.values()], counts: { images: images.size, videos: videos.size } };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'media-finder' }));

app.post('/api/scan', async (req, res) => {
  try {
    if (typeof req.body.url !== 'string' || req.body.url.length > 2048) throw new Error('A valid URL is required');
    const result = await fetchLimited(req.body.url, MAX_HTML, 'text/html,application/xhtml+xml');
    const contentType = String(result.headers['content-type'] || '');
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('URL did not return an HTML page');
    const data = extractMedia(result.buffer.toString('utf8'), result.url);
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'Scan failed' });
  }
});

app.get('/api/proxy', async (req, res) => {
  try {
    const rawURL = String(req.query.url || '');
    if (rawURL.length > 2048) throw new Error('URL is too long');
    if (/\.(m3u8|mpd)(?:\?|$)/i.test(rawURL)) throw new Error('Streaming manifests are not downloadable');
    const result = await fetchLimited(rawURL, MAX_FILE);
    const contentType = String(result.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const filename = path.basename(new URL(result.url).pathname) || 'media-file';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.buffer);
  } catch (error) {
    res.status(400).send(error.message || 'Download failed');
  }
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 400).json({ ok: false, error: error.message || 'Request failed' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Media Finder listening on ${PORT}`));

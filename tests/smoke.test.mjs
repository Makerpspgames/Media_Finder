import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let wrangler;

async function waitReady(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('wrangler dev did not become ready');
}

before(async () => {
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { stdio: 'ignore' });
  await waitReady();
});

after(() => { if (wrangler) wrangler.kill('SIGTERM'); });

const scan = body => fetch(`${BASE}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health endpoint responds ok', async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('static frontend is served', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('favicon is served without 404', async () => {
  const r = await fetch(`${BASE}/favicon.ico`);
  assert.equal(r.status, 200);
});

test('scan rejects malformed JSON', async () => {
  const r = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Invalid JSON/);
});

test('scan rejects invalid URL', async () => {
  const r = await scan({ url: 'not-a-url' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Invalid URL/);
});

test('scan blocks localhost and internal hosts', async () => {
  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://metadata.google.internal/x']) {
    const r = await scan({ url });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /blocked/);
  }
});

test('unknown api route returns 404', async () => {
  const r = await fetch(`${BASE}/api/nope`);
  assert.equal(r.status, 404);
});

test('proxy requires a url', async () => {
  const r = await fetch(`${BASE}/api/proxy`);
  assert.equal(r.status, 400);
});

test('proxy refuses streaming manifests', async () => {
  const r = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('https://example.com/x.m3u8')}`);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /not downloadable/);
});

test('proxy blocks internal hosts', async () => {
  const r = await fetch(`${BASE}/api/proxy?url=${encodeURIComponent('http://127.0.0.1:8799/api/health')}`);
  assert.equal(r.status, 400);
});

test('scan rate limit returns 429 after its budget is exhausted', async () => {
  let last;
  for (let i = 0; i < 20; i++) last = await scan({ url: 'not-a-url' });
  assert.equal(last.status, 429);
});

test('proxy rate limit returns 429 after its separate budget is exhausted', async () => {
  let last;
  for (let i = 0; i < 105; i++) last = await fetch(`${BASE}/api/proxy`);
  assert.equal(last.status, 429);
});

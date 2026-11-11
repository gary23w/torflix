// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Torflix on a Raspberry Pi's console (no desktop, e.g. RetroPie): the backend. The TV shell
// (pi/torflix-tv.py) starts it with Torflix's own Node and talks to it over the same loopback
// bridge as the Android app (src/android/backend.js), without the page's files:
//
//   POST /rpc/<command>   a JSON array of arguments → { ok, value } or { ok: false, error }
//   GET  /events          Server-Sent Events, one { name, payload } per message
//   GET  /image?url=…     a poster or picture, fetched and kept here: the shell's Python
//                         (3.4 on Raspbian Jessie) does not check certificates
//
// Every request must carry the `tp` cookie with the token the shell passed in.
//
// Environment: TORFLIX_TOKEN (32 hex characters), TORFLIX_DATA, TORFLIX_DOWNLOADS. When the
// bridge listens it prints `TORFLIX_READY {"port":P}`.

import '../main/threadpool.js';
import '../android/rejections.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createCore } from '../main/core.js';
import { createCommands, invokeCommand } from '../main/commands.js';
import { toWire, fromWire, hasToken } from '../android/bridge.js';

const MAX_BODY = 16 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const MAX_WAITING_EVENTS = 1000;
/** A Pi's SD card is small: a first run starts with this cache limit (changeable in Settings). */
const DEFAULT_CACHE_LIMIT_GB = 4;
/**
 * A first run also caps downloads (changeable in Settings). On a Raspberry Pi 3 every byte from
 * a peer is decrypted, hashed and bookkept on one 1.2 GHz core: at 4 to 5 MB/s from 40 peers
 * that core was full, the stream fell behind its own download, and the film stalled; capped at
 * 2 MB/s (16 Mbit/s, twice a typical 1080p release) it played without a stall.
 */
const DEFAULT_DOWNLOAD_LIMIT_KIB = 2048;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
/** Pictures not shown for this long are deleted at start-up. */
const IMAGE_KEEP_MS = 60 * 24 * 3600 * 1000;

const token = process.env.TORFLIX_TOKEN ?? '';
if (!/^[0-9a-f]{32}$/.test(token)) {
  console.error('[backend] TORFLIX_TOKEN must be 32 hex characters.');
  process.exit(2);
}
const dataDir = process.env.TORFLIX_DATA;
const downloadDir = process.env.TORFLIX_DOWNLOADS;
if (!dataDir || !downloadDir) {
  console.error('[backend] TORFLIX_DATA and TORFLIX_DOWNLOADS are required.');
  process.exit(2);
}
const imageDir = path.join(dataDir, 'images');
const version = process.env.TORFLIX_VERSION ?? '0.0.0';

main().catch((err) => {
  console.error('[backend] start-up failed:', err?.stack ?? err);
  process.exit(1);
});

async function main() {
  const firstRun = !fs.existsSync(path.join(dataDir, 'settings.json'));
  await fsp.mkdir(imageDir, { recursive: true });
  pruneImages().catch(() => {});

  const clients = new Set();
  let waiting = [];
  const send = (name, payload) => {
    const message = `data: ${JSON.stringify(toWire({ name, payload }))}\n\n`;
    if (clients.size === 0) {
      waiting.push(message);
      if (waiting.length > MAX_WAITING_EVENTS) waiting.shift();
      return;
    }
    for (const res of clients) res.write(message);
  };

  const ctx = await createCore({
    dataDir,
    defaultDownloadDir: downloadDir,
    send,
    version,
    platform: 'raspberry-pi',
    share: { deviceName: 'Raspberry Pi' },
  });
  if (firstRun) ctx.settings.update({ storage: { cacheLimitGb: DEFAULT_CACHE_LIMIT_GB }, bandwidth: { downloadLimitKib: DEFAULT_DOWNLOAD_LIMIT_KIB } });
  const commands = createCommands(ctx, {
    version,
    // No folder pickers, file manager or web browser on the console.
    chooseFolder: async () => null,
    openPath: async () => false,
    openExternal: async () => {},
  });

  let port = 0;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[bridge] request failed:', err?.stack ?? err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else res.destroy();
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.host !== `127.0.0.1:${port}` || !hasToken(req.headers.cookie, token)) return end(res, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    const rpc = /^\/rpc\/([A-Za-z]+)$/.exec(url.pathname);
    if (rpc) {
      if (req.method !== 'POST') return end(res, 405);
      const body = await readBody(req);
      if (body === null) return end(res, 413);
      let args;
      try {
        args = fromWire(JSON.parse(body));
      } catch {
        return end(res, 400);
      }
      if (!Array.isArray(args)) return end(res, 400);
      const result = await invokeCommand(commands, rpc[1], args);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(toWire(result)));
    }
    if (req.method !== 'GET') return end(res, 405);
    if (url.pathname === '/events') return events(req, res);
    if (url.pathname === '/image') return image(url.searchParams.get('url'), res);
    return end(res, 404);
  }

  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clients.add(res);
    for (const message of waiting) res.write(message);
    waiting = [];
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      clients.delete(res);
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  ctx.onRendererReady = () => {
    ctx.rendererReady = true;
  };
  ctx.startBackground();
  console.log(`TORFLIX_READY ${JSON.stringify({ port })}`);

  let stopping = null;
  const stop = (why) => {
    if (stopping) return stopping;
    console.log(`[backend] stopping (${why})`);
    stopping = (async () => {
      for (const res of clients) res.end();
      clients.clear();
      server.close();
      await ctx.shutdown({ verbose: true });
    })()
      .catch((err) => console.error('[backend] shutdown failed:', err?.stack ?? err))
      .finally(() => process.exit(0));
    return stopping;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // If the shell dies without stopping us, we are reparented: do not run on alone.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) stop('the shell is gone');
  }, 5000).unref();
}

/** Picture downloads in flight, so a row of cards asking at once fetches each picture once. */
const fetching = new Map();

/** Sends a picture from the cache, fetching it first if need be; 404 when it cannot be had. */
async function image(link, res) {
  let url;
  try {
    url = new URL(link ?? '');
  } catch {
    return end(res, 400);
  }
  if (url.protocol !== 'https:') return end(res, 400);
  const file = path.join(imageDir, crypto.createHash('sha1').update(url.href).digest('hex'));
  let body = await fsp.readFile(file).catch(() => null);
  if (body) fsp.utimes(file, new Date(), new Date()).catch(() => {});
  else {
    if (!fetching.has(url.href)) fetching.set(url.href, fetchImage(url.href, file).finally(() => fetching.delete(url.href)));
    body = await fetching.get(url.href);
  }
  if (!body) return end(res, 404);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

async function fetchImage(href, file) {
  try {
    const r = await fetch(href, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS), headers: { 'User-Agent': `Torflix/${version} (https://github.com/gary23w/torflix; raspberry-pi)` } });
    if (!r.ok || !/^image\//.test(r.headers.get('content-type') ?? '')) return null;
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length === 0 || body.length > MAX_IMAGE) return null;
    await fsp.writeFile(file, body).catch(() => {});
    return body;
  } catch {
    return null;
  }
}

async function pruneImages() {
  const cutoff = Date.now() - IMAGE_KEEP_MS;
  for (const name of await fsp.readdir(imageDir)) {
    const file = path.join(imageDir, name);
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fsp.rm(file, { force: true });
  }
}

function end(res, status) {
  res.statusCode = status;
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

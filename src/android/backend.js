// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Torflix on Android TV: the backend. The Android app starts it as a Node child process. It
// runs the same services as the desktop main process (core.js) and serves the renderer and its
// commands to the app's WebView over a loopback bridge:
//
//   GET  /renderer/…, /shared/…, /assets/…, /android/tp-shim.js   the app's own files
//   POST /rpc/<command>   a JSON array of arguments → { ok, value } or { ok: false, error }
//   GET  /events          Server-Sent Events, one { name, payload } per message
//
// Every request must carry the `tp` cookie, which the app sets from the token it passed in.
// Bytes travel as { $bytes } (bridge.js). Video goes through the stream server as on the
// desktop, with its own per-run token in every URL.
//
// Environment: TORFLIX_TOKEN (32 hex characters), TORFLIX_DATA, TORFLIX_DOWNLOADS, and
// TORFLIX_STATIC (the folder holding renderer/, shared/, android/ and assets/; by default the
// source tree). When the bridge listens it prints `TORFLIX_READY {"port":P}`.

import '../main/threadpool.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createCore } from '../main/core.js';
import { createCommands, invokeCommand } from '../main/commands.js';
import { toWire, fromWire, adaptIndex, hasToken } from './bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
/** Events kept for a page that has not connected yet. */
const MAX_WAITING_EVENTS = 1000;
/** Storage on TV boxes is small: a first run starts with this cache limit (changeable in Settings). */
const DEFAULT_CACHE_LIMIT_GB = 4;
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json', woff2: 'font/woff2' };

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
const SERVED = servedDirs(process.env.TORFLIX_STATIC);

main().catch((err) => {
  console.error('[backend] start-up failed:', err?.stack ?? err);
  process.exit(1);
});

async function main() {
  const firstRun = !fs.existsSync(path.join(dataDir, 'settings.json'));
  await fsp.mkdir(dataDir, { recursive: true });

  const clients = new Set();
  /**
   * Events sent while no page listens yet (it is still loading, or reloading): they are handed
   * over when it connects. Information found from the cache arrives within moments of the page
   * asking for Browse, before its event stream is open.
   */
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

  const ctx = await createCore({ dataDir, defaultDownloadDir: downloadDir, send, version: process.env.TORFLIX_VERSION ?? '0.0.0', platform: 'android-tv' });
  if (firstRun) ctx.settings.update({ storage: { cacheLimitGb: DEFAULT_CACHE_LIMIT_GB } });
  const commands = createCommands(ctx, {
    // The bundle has the package version built in (tools/android/build.mjs).
    version: process.env.TORFLIX_VERSION ?? '0.0.0',
    // No folder pickers or file manager on a TV: the renderer hides these.
    chooseFolder: async () => null,
    openPath: async () => false,
    // Links open through the app (tpNative.openLink); nothing to do here.
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Only the app's WebView, which holds the cookie, on the address it was given.
    if (req.headers.host !== `127.0.0.1:${port}` || !hasToken(req.headers.cookie, token)) return end(res, 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}`) return end(res, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    const rpc = /^\/rpc\/([A-Za-z]+)$/.exec(url.pathname);
    if (rpc) {
      if (req.method !== 'POST') return end(res, 405);
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return end(res, 415);
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

    if (url.pathname === '/events') return req.method === 'GET' ? events(req, res) : end(res, 405);
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405);
    return serveFile(url.pathname, req, res);
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
  // If the app dies without stopping us, we are reparented: do not run on alone.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) stop('the app is gone');
  }, 5000).unref();
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

/** Where each top-level folder is served from: the app's copy, or the source tree. */
function servedDirs(root) {
  if (root) return { renderer: path.join(root, 'renderer'), shared: path.join(root, 'shared'), assets: path.join(root, 'assets'), android: path.join(root, 'android') };
  const repo = path.resolve(here, '..', '..');
  return { renderer: path.join(repo, 'src', 'renderer'), shared: path.join(repo, 'src', 'shared'), assets: path.join(repo, 'assets'), android: path.join(repo, 'src', 'android') };
}

/** The same files the desktop serves on `tp://app/`, plus the bridge shim. */
async function serveFile(pathname, req, res) {
  let parts;
  try {
    parts = decodeURIComponent(pathname).split('/').filter(Boolean);
  } catch {
    return end(res, 400);
  }
  const base = SERVED[parts[0]];
  if (!base || parts.length < 2 || parts.slice(1).some((p) => p === '..' || p === '.' || p.includes('\\'))) return end(res, 404);
  // Of the Android folder, only the shim is for the page.
  if (parts[0] === 'android' && !(parts.length === 2 && parts[1] === 'tp-shim.js')) return end(res, 404);
  const file = path.join(base, ...parts.slice(1));
  if (!file.startsWith(base + path.sep)) return end(res, 404);
  let body;
  try {
    body = await fsp.readFile(file);
  } catch {
    return end(res, 404);
  }
  if (parts[0] === 'renderer' && parts.length === 2 && parts[1] === 'index.html') {
    body = Buffer.from(adaptIndex(body.toString('utf8')));
  }
  res.setHeader('Content-Type', MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

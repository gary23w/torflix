// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Torflix: the main process. It owns the window and the `tp://` scheme, and starts the torrent
// engine, the loopback stream server, search, the queue's background downloads, the library,
// and settings (core.js); the renderer (a sandboxed, isolated window) talks to them only
// through the IPC commands in ipc.js.

import './threadpool.js';
import { app, BrowserWindow, Menu, session, shell, nativeImage, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCore } from './core.js';
import { registerIpc } from './ipc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const SMOKE = process.argv.includes('--smoke');
const DEV = process.argv.includes('--dev') || Boolean(process.env.TORRENTPLAYER_DEV);
/** Hosts the window may load poster images from (TVmaze and Wikimedia; no key, no account). */
const IMAGE_HOSTS = /(^|\.)(tvmaze\.com|wikimedia\.org)$/i;

app.setName('Torflix');
app.setAppUserModelId('io.torflix.app');

// The window loads from `tp://app/…`, a scheme with a real origin, so ES modules and a strict
// Content Security Policy work and only the app's own files are served.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
]);

const SERVED = { renderer: path.join(ROOT, 'src', 'renderer'), shared: path.join(ROOT, 'src', 'shared'), assets: path.join(ROOT, 'assets') };
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json', woff2: 'font/woff2' };

function serveApp() {
  protocol.handle('tp', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const base = SERVED[parts[0]];
    if (!base || parts.slice(1).some((p) => p === '..' || p === '.')) return new Response('Not found', { status: 404 });
    const file = path.join(base, ...parts.slice(1));
    if (!file.startsWith(base)) return new Response('Not found', { status: 404 });
    try {
      const body = await fsp.readFile(file);
      const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// The self-test never touches the real data or download folders.
if (SMOKE) {
  const smokeDir = path.join(app.getPath('temp'), 'Torflix-smoke');
  fs.rmSync(smokeDir, { recursive: true, force: true });
  app.setPath('userData', path.join(smokeDir, 'data'));
  app.setPath('downloads', path.join(smokeDir, 'downloads'));
  // A folder of data files (queue.json, library.json, settings.json) to start the self-test from.
  if (process.env.TORRENTPLAYER_SMOKE_SEED) {
    fs.mkdirSync(path.join(smokeDir, 'data'), { recursive: true });
    fs.cpSync(process.env.TORRENTPLAYER_SMOKE_SEED, path.join(smokeDir, 'data'), { recursive: true });
  }
}

// One instance: a second launch (a .torrent file or magnet link) is handed to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main().catch((err) => {
    console.error('[main] start-up failed:', err?.stack ?? err);
    app.exit(1);
  });
}

async function main() {
  await app.whenReady();
  serveApp();
  Menu.setApplicationMenu(buildMenu());

  let win = null;
  const send = (name, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('tp:event', { name, payload });
  };
  const ctx = await createCore({
    dataDir: app.getPath('userData'),
    defaultDownloadDir: path.join(app.getPath('downloads'), 'Torflix'),
    send,
    version: app.getVersion(),
    platform: 'desktop',
  });
  win = createWindow();
  ctx.win = win;

  const pendingOpens = [];
  let rendererReady = false;
  ctx.onRendererReady = () => {
    rendererReady = true;
    ctx.rendererReady = true;
    for (const req of pendingOpens.splice(0)) send('open-torrent', req);
  };
  const open = (req) => {
    if (rendererReady) send('open-torrent', req);
    else pendingOpens.push(req);
    if (win.isMinimized()) win.restore();
    win.focus();
  };
  const openArgs = async (argv) => {
    for (const arg of argv.slice(1)) {
      if (/^magnet:\?/i.test(arg)) open({ kind: 'magnet', value: arg });
      else if (/\.torrent$/i.test(arg) && fs.existsSync(arg)) {
        try {
          const bytes = new Uint8Array(await fsp.readFile(arg));
          open({ kind: 'file', value: bytes, name: path.basename(arg) });
        } catch {
          // unreadable
        }
      }
    }
  };
  app.on('second-instance', (_e, argv) => openArgs(argv));
  app.on('open-file', (e, file) => {
    e.preventDefault();
    openArgs([process.execPath, file]);
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    openArgs([process.execPath, url]);
  });

  registerIpc(ctx);
  ctx.startBackground();

  await win.loadURL('tp://app/renderer/index.html');
  openArgs(process.argv);

  let shuttingDown = null;
  app.on('before-quit', (e) => {
    e.preventDefault();
    shutdown().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => {
    if (!shuttingDown) app.quit();
  });

  /**
   * Runs once, however many times quitting is asked for. The body starts on a microtask, so
   * the window's `closed` event (fired synchronously inside it) sees the promise already set.
   */
  function shutdown() {
    if (!shuttingDown) {
      shuttingDown = Promise.resolve()
        .then(doShutdown)
        .catch((err) => console.error('[main] shutdown failed:', err?.stack ?? err));
    }
    return shuttingDown;
  }

  function doShutdown() {
    return ctx.shutdown({
      // The window goes first, so nothing reads from the stream server while it closes.
      closeWindow: () => {
        if (!win.isDestroyed()) win.destroy();
      },
      // WebTorrent loads a WebRTC addon (node-datachannel) that runs threads of its own; leaving
      // the process with them alive crashes it on exit (an access violation on Windows).
      releaseNative: async () => {
        try {
          (await import('node-datachannel')).cleanup?.();
        } catch {
          // not loaded
        }
      },
      verbose: DEV || SMOKE,
    });
  }

  if (SMOKE) {
    const { runSmoke } = await import('./smoke.js');
    const ok = await runSmoke(ctx, ROOT).catch((err) => {
      console.error('[smoke] failed:', err?.stack ?? err);
      return false;
    });
    await shutdown();
    app.exit(ok ? 0 : 1);
  }
}

function createWindow() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    center: true,
    show: false,
    title: 'Torflix',
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      enableWebSQL: false,
      navigateOnDragDrop: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      if (DEV || SMOKE) win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'fullscreen'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
  // Only the app's own files, the loopback stream server, and poster images from the two
  // keyless information sources are ever fetched by the window; APIs are asked from here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    let allowed = url.startsWith('tp://app/') || url.startsWith('http://127.0.0.1:') || url.startsWith('devtools://') || url.startsWith('data:') || url.startsWith('blob:');
    if (!allowed && url.startsWith('https://')) {
      try {
        allowed = details.resourceType === 'image' && IMAGE_HOSTS.test(new URL(url).hostname);
      } catch {
        allowed = false;
      }
    }
    callback({ cancel: !allowed });
  });
  win.webContents.on('console-message', (...args) => {
    const { level, message } = consoleMessage(args);
    if (level >= 2 || DEV || SMOKE) console.log(`[renderer] ${message}`);
  });
  return win;
}

/** Normalizes the `console-message` event across Electron versions: `{ level: 0–3, message }`. */
export function consoleMessage(args) {
  if (typeof args[1] === 'number') return { level: args[1], message: String(args[2]) };
  const ev = args[0] ?? {};
  const level = { verbose: 0, debug: 0, info: 1, warning: 2, error: 3 }[ev.level] ?? 1;
  return { level, message: String(ev.message ?? '') };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Based on TorrentPlayer (GitHub)', click: () => shell.openExternal('https://github.com/torrentplayer/torrentplayer') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

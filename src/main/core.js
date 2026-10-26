// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Everything behind the window: the torrent engine, the loopback stream server, search, the
// queue's background downloads, the library, and settings, wired together and to one event
// sink. The Electron main process and the Android backend both start the app through here, so
// they run the same services in the same order.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { SettingsStore } from './settings.js';
import { Library } from './library.js';
import { Engine } from './engine.js';
import { ResumeStore } from './resume.js';
import { StreamServer } from './stream-server.js';
import { Streams } from './streams.js';
import { SearchService } from './search.js';
import { Preloader } from './preloader.js';
import { Prefetch } from './prefetch.js';
import { Metadata } from './metadata.js';
import { Browse } from './browse.js';
import { Titles } from './titles.js';
import { Downloads } from './downloads.js';
import { Cache } from './cache.js';
import { MediaTools } from './media-tools.js';

/**
 * Starts the services and wires their events to `send(name, payload)`. Background downloads
 * and cache trimming wait for `startBackground()`, so the caller can register its commands
 * first.
 * @param {object} opts
 * @param {string} opts.dataDir settings, library, resume data and lookup caches
 * @param {string} opts.defaultDownloadDir used when none is chosen in Settings
 * @param {(name: string, payload: any) => void} opts.send delivers an event to the window
 * @param {string} opts.version Torflix's version, for the User-Agent metadata sources see
 * @param {string} opts.platform 'desktop' or 'android-tv', the same
 */
export async function createCore({ dataDir, defaultDownloadDir, send, version = '0', platform = null }) {
  const settings = new SettingsStore(dataDir, defaultDownloadDir);
  const downloadDir = settings.activeDownloadDir;
  await fsp.mkdir(downloadDir, { recursive: true }).catch(() => {});

  const library = new Library(dataDir);
  // Saved metadata and piece maps: adding a torrent again needs no peer and no rehash.
  const resume = new ResumeStore(path.join(dataDir, 'resume'));
  resume.prune().catch(() => {});
  const engine = new Engine({ downloadDir, settings, resume });
  const server = new StreamServer();
  const media = new MediaTools({ settings });
  const streams = new Streams({ engine, server, library, settings, media });
  server.convertAudio = (opts) => media.convertAudio(opts);
  server.subtitleSrt = (id, fileIndex) => streams.subtitleSrt(id, fileIndex);
  const search = new SearchService({ settings });
  // With FFmpeg, Dolby and DTS audio plays (converted), so search stops ranking it down.
  const applyTools = (t) => {
    search.audioConverts = Boolean(t.ffmpeg);
  };
  media.onChange = applyTools;
  media.tools().then(applyTools).catch(() => {});
  const preloader = new Preloader({ engine, settings, server, library });
  const prefetch = new Prefetch({ engine });
  const metadata = new Metadata({ dataDir, settings, version, platform });
  const browse = new Browse({ dataDir, search, metadata, settings });
  const titles = new Titles({ browse, metadata, search, library });
  const downloads = new Downloads({ engine, library, streams, settings });
  const cache = new Cache({ downloadDir, engine, library, settings });

  await Promise.all([engine.start(), server.listen()]);

  search.setSink((searchId, progress) => send('search-progress', { searchId, progress }));
  library.on('library-changed', () => send('library-changed', null));
  preloader.on('status', (status) => send('preload-status', status));
  prefetch.on('thumbnail', (payload) => send('thumbnail', payload));
  prefetch.on('prefetched', (payload) => send('prefetched', payload));
  browse.on('rows', (payload) => send('browse-rows', payload));
  browse.on('title-meta', (payload) => send('title-meta', payload));
  engine.on('torrent-error', (entry, err) => send('torrent-error', { torrentId: entry.id, message: err?.message ?? String(err) }));
  engine.on('client-error', (payload) => send('engine-error', payload));
  engine.on('restarted', (payload) => send('engine-restarted', payload));
  streams.onStopped = (streamId, reason) => send('stream-stopped', { streamId, reason });
  engine.on('removed', (entry) => streams.stopEntry(entry));
  // The window keeps its own copy of the settings; a change from anywhere reaches it.
  settings.on('change', () => send('settings-changed', settings.view()));

  const ctx = { engine, server, streams, search, preloader, prefetch, library, downloads, settings, cache, downloadDir, browse, titles, metadata, media };

  ctx.startBackground = () => {
    downloads.start();
    cache.start();
  };

  /**
   * Stops everything and waits for the engine's sockets to close. `closeWindow` runs before any
   * stream stops, so nothing reads from the stream server while it closes (a player whose
   * stream closed first would flash an error). `releaseNative` frees native addons whose own
   * threads would crash the process on exit.
   */
  ctx.shutdown = async ({ closeWindow = () => {}, releaseNative = async () => {}, verbose = false } = {}) => {
    downloads.stop();
    cache.stop();
    search.cancel();
    const t0 = Date.now();
    closeWindow();
    streams.stopAll();
    await Promise.race([
      (async () => {
        await prefetch.reset();
        await preloader.destroy();
        await server.close();
        await engine.destroy();
        await releaseNative();
        await settings.flush();
        await library.flush();
        await metadata.flush();
        await browse.flush();
      })(),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    if (verbose) console.log(`[main] shutdown took ${Date.now() - t0} ms`);
    // The engine's sockets close asynchronously; leaving before they do crashes the process on
    // exit. Wait until no socket handles are left (or a few seconds), then a moment more.
    const live = () => process.getActiveResourcesInfo().filter((r) => /TCP|UDP|UTP|Pipe/i.test(r));
    const until = Date.now() + 6000;
    while (live().length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (verbose) {
      const counts = {};
      for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1;
      console.log(`[main] resources at exit: ${JSON.stringify(counts)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  };

  return ctx;
}

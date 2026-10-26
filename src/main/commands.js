// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Every command the renderer may invoke, with argument checks. Each command answers
// `{ ok: true, value }` or `{ ok: false, error: { kind, message, fieldErrors? } }`; the bridge
// in front of them (Electron IPC in ipc.js, HTTP on Android) turns the latter into a thrown
// error with the same fields. The commands know nothing of the platform: folder pickers,
// opening a folder or a link, and the version come in as `platform`.

import { Buffer } from 'node:buffer';
import { fileKind, isImage } from '../shared/files.js';
import { EngineError } from './engine.js';

const MAX_LINK = 16 * 1024;
const MAX_TORRENT_FILE = 10 * 1024 * 1024;
const MAX_IMAGE_PREVIEW = 5 * 1024 * 1024;
const MAX_TEXT_PREVIEW = 64 * 1024;

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);

function fail(kind, message) {
  const e = new EngineError(kind, message);
  return e;
}

function shape(err) {
  return {
    kind: err?.kind ?? (err?.fieldErrors ? 'invalidSettings' : 'internal'),
    message: err?.message ?? String(err),
    fieldErrors: err?.fieldErrors ?? null,
  };
}

/** Runs one command and shapes its outcome; an unknown name is answered like any failure. */
export async function invokeCommand(commands, name, args) {
  const fn = Object.hasOwn(commands, name) ? commands[name] : null;
  if (!fn) return { ok: false, error: { kind: 'unknownCommand', message: 'No such command.', fieldErrors: null } };
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    if (!(err instanceof EngineError) && !err?.fieldErrors) console.error(`[ipc] ${name} failed:`, err?.stack ?? err);
    return { ok: false, error: shape(err) };
  }
}

/**
 * The commands, by name.
 * @param {object} ctx the services from core.js
 * @param {object} platform
 * @param {string} platform.version the app's version
 * @param {(opts: {title: string, create?: boolean}) => Promise<string|null>} platform.chooseFolder
 * @param {(dir: string) => Promise<boolean>} platform.openPath shows a folder; false if it could not
 * @param {(url: string) => Promise<void>} platform.openExternal opens an http(s) link
 */
export function createCommands(ctx, platform) {
  const { engine, streams, search, preloader, prefetch, library, downloads, settings, cache, downloadDir, browse, titles, metadata } = ctx;
  const commands = {};
  const handle = (name, fn) => {
    commands[name] = fn;
  };

  const requireLink = (link) => {
    if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LINK) throw fail('invalidLink', 'Enter a magnet link or a link to a .torrent file.');
    return link.trim();
  };
  const requireBytes = (bytes, max, what) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw fail('invalidFile', `That is not a ${what}.`);
    if (bytes.byteLength > max) throw fail('tooLarge', `That ${what} is too large.`);
    return bytes;
  };
  const entryOf = (id) => {
    const e = engine.get(id);
    if (!e || !e.ready) throw fail('noSuchTorrent', 'That torrent is not open.');
    return e;
  };
  /** A title page's title: `{ key, kind, title, year }`. */
  const requireTitle = (req) => {
    const key = typeof req?.key === 'string' && req.key.length <= 300 && /^(movie|tv|tvmaze):/.test(req.key) ? req.key : null;
    const title = typeof req?.title === 'string' ? req.title.trim().slice(0, 300) : '';
    if (!key || !title) throw fail('invalid', 'Bad title.');
    const year = Number.isInteger(req.year) && req.year >= 1870 && req.year <= 2100 ? req.year : null;
    return { key, kind: req.kind === 'tv' ? 'tv' : 'movie', title, year };
  };
  /** An episode to pick in a season pack: `{ season, episode }`, or null. */
  const optionalPick = (pick) => (pick && isInt(pick.season) && isInt(pick.episode) && pick.season < 200 && pick.episode < 5000 ? { season: pick.season, episode: pick.episode } : null);

  handle('appInfo', () => ({
    name: 'Torflix',
    version: platform.version,
    license: 'MIT OR Apache-2.0',
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node,
    platform: process.platform,
    engine: 'WebTorrent',
    downloadDir,
  }));
  handle('rendererReady', () => {
    ctx.onRendererReady?.();
    return true;
  });

  // ----- torrents -----
  handle('addTorrentLink', async (link, infoHash = null) => {
    const l = requireLink(link);
    const entry = await engine.add(l, { infoHash: isHash(infoHash) ? infoHash.toLowerCase() : null, origin: 'user' });
    preloader.claim(entry.infoHash);
    return engine.summary(entry);
  });
  handle('addTorrentFile', async (bytes) => {
    const b = requireBytes(bytes, MAX_TORRENT_FILE, '.torrent file');
    const entry = await engine.add(null, { bytes: b, origin: 'user' });
    preloader.claim(entry.infoHash);
    return engine.summary(entry);
  });
  handle('listTorrents', () => engine.list());
  handle('torrentDetails', (id) => engine.details(entryOf(id)));
  handle('removeTorrent', async (id, destroyStore = false) => {
    const e = entryOf(id);
    const active = streams.active();
    if (active && active.entry === e) streams.stop(active.id, 'removed');
    await engine.remove(e, { destroyStore: Boolean(destroyStore) });
    return true;
  });

  // ----- playback -----
  handle('startStream', async (req) => {
    if (!req || typeof req !== 'object') throw fail('invalid', 'Bad request.');
    const bytes = req.bytes instanceof Uint8Array ? requireBytes(req.bytes, MAX_TORRENT_FILE, '.torrent file') : null;
    const source = bytes ? null : requireLink(req.source);
    const fileIndex = req.fileIndex === null || req.fileIndex === undefined ? null : req.fileIndex;
    if (fileIndex !== null && !isInt(fileIndex)) throw fail('invalid', 'Bad file index.');
    const infoHash = isHash(req.infoHash) ? req.infoHash.toLowerCase() : null;
    const pick = fileIndex === null ? optionalPick(req.pick) : null;
    // Where to start: from the start, from a position the page chose, or (unsaid) the saved one.
    const positionSecs = req.fromStart === true ? 0 : typeof req.positionSecs === 'number' && Number.isFinite(req.positionSecs) && req.positionSecs >= 0 ? req.positionSecs : undefined;
    // A preload of something else would compete with this start for the connection; this
    // one's own (a title page's warm-up) is the viewer's now, before its metadata is even in.
    const preloading = preloader.status()?.infoHash ?? null;
    if (preloading && infoHash && preloading !== infoHash) preloader.cancel().catch(() => {});
    if (infoHash) preloader.claim(infoHash);
    const info = await streams.start({ source, bytes, fileIndex, infoHash, pick, positionSecs });
    if (preloader.status()?.infoHash && preloader.status().infoHash !== info.infoHash) preloader.cancel().catch(() => {});
    preloader.claim(info.infoHash);
    return info;
  });
  handle('stopStream', (id) => {
    if (isInt(id)) streams.stop(id);
    return true;
  });
  handle('streamStats', (id) => {
    if (!isInt(id)) throw fail('invalid', 'Bad stream id.');
    return streams.stats(id);
  });
  handle('reportPlayback', (id, report) => {
    if (!isInt(id) || !report || typeof report !== 'object') return false;
    streams.report(id, {
      positionSecs: Number(report.positionSecs),
      durationSecs: Number(report.durationSecs),
      ended: report.ended === true,
      seek: report.seek === true,
      firstFrameMs: typeof report.firstFrameMs === 'number' ? report.firstFrameMs : undefined,
      lastSeekMs: typeof report.lastSeekMs === 'number' ? report.lastSeekMs : undefined,
    });
    return true;
  });
  handle('streamSubtitles', (id) => {
    if (!isInt(id)) throw fail('invalid', 'Bad stream id.');
    return streams.subtitles(id);
  });
  handle('loadSubtitles', (id, fileIndex) => {
    if (!isInt(id) || !isInt(fileIndex)) throw fail('invalid', 'Bad request.');
    return streams.loadSubtitles(id, fileIndex);
  });
  handle('parseSubtitles', (bytes, name) => {
    const b = requireBytes(bytes, 5 * 1024 * 1024, 'subtitle file');
    return streams.parseLocal(b, typeof name === 'string' ? name.slice(0, 260) : '');
  });
  handle('streamAudio', (id, languages) => {
    if (!isInt(id)) throw fail('invalid', 'Bad stream id.');
    const langs = Array.isArray(languages) ? languages.filter((l) => typeof l === 'string' && l.length <= 35).slice(0, 8) : [];
    return streams.audio(id, langs);
  });
  handle('mediaTools', () => ctx.media.status());
  handle('chooseFfmpegDir', () => platform.chooseFolder({ title: 'Choose the folder with ffmpeg and ffprobe' }));

  // ----- search -----
  handle('searchTorrents', (query, opts) => {
    const categories = Array.isArray(opts?.categories) ? opts.categories.filter((c) => Number.isInteger(c)) : [];
    prefetch.reset();
    return search.start(typeof query === 'string' ? query : '', { categories });
  });
  handle('prefetchResults', (list) => {
    if (!Array.isArray(list)) throw fail('invalid', 'Bad request.');
    const clean = list
      .slice(0, 20)
      .filter((r) => r && typeof r.key === 'string' && r.key.length <= 4096 && typeof r.link === 'string' && r.link.length <= MAX_LINK)
      .map((r) => ({ key: r.key, link: r.link, infoHash: isHash(r.infoHash) ? r.infoHash.toLowerCase() : null }));
    // Off by default: it joins the swarms of the results on screen.
    if (!settings.settings.search.prefetchResults) return prefetch.snapshot(clean.map((r) => r.key));
    return prefetch.request(clean);
  });
  handle('previewFrame', () => preloader.frame());

  // ----- browse -----
  handle('browseRows', (opts) => {
    if (!settings.settings.browse.enabled) return { fetchedAt: 0, error: null, hero: null, rows: [], disabled: true };
    return browse.rows({ refresh: opts?.refresh === true });
  });
  handle('titlePage', (req) => titles.page(requireTitle(req)));
  handle('titleInfo', (req) => titles.info(requireTitle(req)));
  handle('titleById', (qid) => {
    if (typeof qid !== 'string' || !/^Q\d{1,12}$/.test(qid)) throw fail('invalid', 'Bad title.');
    return metadata.byWikidata(qid);
  });
  handle('titleCopies', (req, opts) => titles.findCopies(requireTitle(req), { season: isInt(opts?.season) && opts.season < 200 ? opts.season : null }));
  handle('titleEpisode', (req, season, episode) => {
    if (!isInt(season) || !isInt(episode) || season >= 200 || episode >= 5000) throw fail('invalid', 'Bad episode.');
    return titles.episode(requireTitle(req), season, episode);
  });
  // Getting a title page's copy ready to play: on by default (Settings → Playback).
  handle('warmUpTitle', (req) => {
    if (!req || typeof req !== 'object') return null;
    const owner = requireTitle(req.title).key;
    const fileIndex = isInt(req.fileIndex) ? req.fileIndex : null;
    const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    return preloader.preload({
      link: requireLink(req.link),
      infoHash: isHash(req.infoHash) ? req.infoHash.toLowerCase() : null,
      reason: 'title',
      owner,
      fileIndex,
      pick: fileIndex === null ? optionalPick(req.pick) : null,
      positionSecs: secs(req.positionSecs),
      durationSecs: secs(req.durationSecs),
    });
  });
  handle('coolDownTitle', async (key) => {
    if (typeof key === 'string' && key.length <= 300) await preloader.cancel({ owner: key });
    return true;
  });
  handle('browseVisible', (visible) => {
    browse.setVisible(visible === true);
    return true;
  });
  handle('lookupRelease', (name) => {
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024) return null;
    return metadata.lookupRelease(name);
  });
  handle('cancelSearch', () => {
    search.cancel();
    return true;
  });
  handle('preloadBest', (req) => {
    if (!req || typeof req !== 'object') return null;
    const link = requireLink(req.link);
    return preloader.preload({ link, infoHash: isHash(req.infoHash) ? req.infoHash.toLowerCase() : null });
  });
  handle('cancelPreload', () => preloader.cancel().then(() => true));
  handle('preloadStatus', () => preloader.status());

  // ----- library and queue -----
  handle('libraryItems', () => library.list());
  handle('libraryRemove', (infoHash, fileIndex) => {
    if (!isHash(infoHash) || !isInt(fileIndex)) throw fail('invalid', 'Bad request.');
    library.remove(infoHash.toLowerCase(), fileIndex);
    return true;
  });
  handle('libraryClear', () => {
    library.clear();
    return true;
  });
  handle('loadQueue', () => library.loadQueue());
  handle('saveQueue', (q) => library.saveQueue(q));
  handle('queueDownloads', () => downloads.current());
  handle('queueReadiness', (ids) => downloads.readiness(Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : []));

  // ----- settings and storage -----
  handle('getSettings', () => settings.view());
  handle('updateSettings', (patch) => {
    if (!patch || typeof patch !== 'object') throw fail('invalid', 'Bad settings.');
    return settings.update(patch);
  });
  handle('chooseDownloadDir', () => platform.chooseFolder({ title: 'Choose the download folder', create: true }));
  handle('cacheUsage', () => cache.usage());
  handle('clearCache', () => cache.clear());
  handle('openDownloadDir', () => platform.openPath(downloadDir));
  handle('openLink', async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4096) throw fail('invalid', 'Only http(s) links can be opened.');
    await platform.openExternal(url);
    return true;
  });

  // ----- file explorer previews -----
  handle('previewFile', async (id, fileIndex) => {
    const e = entryOf(id);
    if (!isInt(fileIndex)) throw fail('invalid', 'Bad file index.');
    const file = engine.file(e, fileIndex);
    const kind = fileKind(file.path);
    const name = file.name;
    if (isImage(file.path)) {
      if (file.length > MAX_IMAGE_PREVIEW) return { kind: null, image: null, text: null, truncated: false, video: null, note: 'Picture too large to preview.' };
      const bytes = await readWhole(file, e);
      const mime = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg';
      return { kind: 'image', image: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, text: null, truncated: false, video: null, note: null };
    }
    if (kind === 'subtitle' || (kind === 'document' && /\.(txt|nfo|md|srt|vtt)$/i.test(name))) {
      const end = Math.min(file.length, MAX_TEXT_PREVIEW) - 1;
      if (end < 0) return { kind: 'text', image: null, text: '', truncated: false, video: null, note: null };
      const bytes = await readRange(file, e, 0, end);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('windows-1252').decode(bytes);
      }
      return { kind: 'text', image: null, text, truncated: file.length > MAX_TEXT_PREVIEW, video: null, note: null };
    }
    if (kind === 'video' || kind === 'audio') return { kind: null, image: null, text: null, truncated: false, video: null, note: 'Press Play to watch it.' };
    return { kind: null, image: null, text: null, truncated: false, video: null, note: 'No preview for this kind of file.' };
  });

  async function readRange(file, entry, start, end) {
    const torrent = entry.torrent;
    const [a, b] = [Math.floor((file.offset + start) / torrent.pieceLength), Math.floor((file.offset + end) / torrent.pieceLength)];
    torrent.select(a, b, 3);
    try {
      return new Uint8Array(await withTimeout(file.arrayBuffer({ start, end }), 45_000));
    } finally {
      try {
        torrent.deselect(a, b);
      } catch {
        // gone
      }
    }
  }
  function readWhole(file, entry) {
    return readRange(file, entry, 0, file.length - 1);
  }

  return commands;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new EngineError('timeout', 'The file did not arrive in time.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

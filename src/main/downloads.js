// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Background downloads of the queue, when turned on in Settings (off by default: then only the
// video being watched downloads). Once a second: rank the queued items, decide which may
// download (the user's limit, and whether playback needs the connection), add torrents four
// at a time, select or deselect their files, keep seeding what finished until the ratio or
// time target when sharing is on, quiet every torrent nothing needs, and take a snapshot the
// queue rows show.

import { playTarget } from '../shared/files.js';
import { addFocus, bufferedAfter, downloadedOf, focusPieces, isComplete, removeFocus, startable } from './pieces.js';

const TICK_MS = 1000;
/** Torrents whose metadata may be pending at once. */
const MAX_STARTING = 4;
/** Playback buffer below which the rest of the queue pauses, and above which it is free. */
const STARVING_SECS = 10;
const RELAXED_SECS = 30;
const STARVING_BYTES = 4 * 1024 * 1024;
const RELAXED_BYTES = 24 * 1024 * 1024;
/** Playback needs this many times its media rate. */
const PLAYBACK_HEADROOM = 1.5;
/** How long a measured peak of the connection counts. */
const CAPACITY_WINDOW_MS = 60_000;
const RETRY_FAILED_MS = 60_000;
/** Until the first frame shows (at most this long), the rest of the queue waits. */
const STARTUP_HOLD_MS = 60_000;
/**
 * A queued file's start and end come before the rest of it, so playing it later starts at
 * once: above the rest of the file (0), below anything the player reads (1 and up).
 */
const STARTABLE_PRIORITY = 0.5;

export class Downloads {
  constructor({ engine, library, streams, settings }) {
    this.engine = engine;
    this.library = library;
    this.streams = streams;
    this.settings = settings;
    this.timer = null;
    this.snapshot = { items: [], link: this.#emptyLink() };
    /** Torrents being added, by group key. */
    this.starting = new Map();
    /** Failed adds, by group key, with when to try again. */
    this.failed = new Map();
    this.peaks = [];
    this.pressure = null;
    this.seedingStarted = false;
  }

  start() {
    this.timer = setInterval(() => {
      try {
        this.#tick();
      } catch (err) {
        console.error('[downloads] tick failed:', err?.stack ?? err);
      }
    }, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  #emptyLink() {
    return { capacityBps: 0, usedBps: 0, uploadBps: 0, active: 0, maxActive: null, playbackNeedBps: null, pressure: 'relaxed' };
  }

  static groupKey(item) {
    return item.infoHash ?? item.source;
  }

  /** The torrent entry of a queue item, if added. */
  entryOf(item) {
    return (item.infoHash && this.engine.byInfoHash(item.infoHash)) || this.engine.bySource(item.source) || null;
  }

  /** The file a queue item names, if its torrent is known. */
  fileOf(item, entry = this.entryOf(item)) {
    if (!entry?.ready) return null;
    const files = this.engine.files(entry);
    const target = item.fileIndex === null ? playTarget(files) : files.find((f) => f.index === item.fileIndex);
    if (!target) return null;
    return { summary: target, file: this.engine.file(entry, target.index) };
  }

  /** Items in download priority: after the current one first, then the rest, current last. */
  ranked(queue) {
    const items = queue.items;
    const at = queue.current === null ? -1 : items.findIndex((i) => i.id === queue.current);
    const after = at < 0 ? items : items.slice(at + 1);
    const before = at < 0 ? [] : items.slice(0, at);
    const current = at < 0 ? [] : [items[at]];
    let ordered = [...after, ...before, ...current];
    if (queue.order === 'fastest') {
      // Fastest torrents first, each torrent's own files in queue order.
      const groups = new Map();
      for (const item of ordered) {
        const key = Downloads.groupKey(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const speed = (key) => {
        const first = groups.get(key)[0];
        const entry = this.entryOf(first);
        return entry?.ready ? entry.torrent.downloadSpeed : -1;
      };
      const keys = [...groups.keys()];
      const rankOf = new Map(keys.map((k, i) => [k, i]));
      keys.sort((a, b) => speed(b) - speed(a) || rankOf.get(a) - rankOf.get(b));
      ordered = keys.flatMap((k) => groups.get(k));
    }
    return ordered;
  }

  /** How playback is doing: `starving`, `guarded`, or `relaxed`; null without a stream. */
  #pressure(stream) {
    if (!stream) return null;
    const file = stream.file;
    if (isComplete(file)) return 'relaxed';
    // Starting: everything the connection has goes to the video until its first frame.
    if (stream.firstFrameMs === null && Date.now() - stream.startedAt < STARTUP_HOLD_MS) return 'starving';
    const srv = this.streams.server.status(stream.id);
    const buffered = bufferedAfter(file, srv?.positionBytes ?? 0);
    if (stream.durationSecs && stream.durationSecs > 0) {
      const secs = buffered / (file.length / stream.durationSecs);
      if (secs < STARVING_SECS) return 'starving';
      if (secs < RELAXED_SECS) return 'guarded';
      return 'relaxed';
    }
    if (buffered < STARVING_BYTES) return 'starving';
    if (buffered < RELAXED_BYTES) return 'guarded';
    return 'relaxed';
  }

  #tick() {
    const queue = this.library.queue;
    const settings = this.settings.settings;
    const stream = this.streams.active();
    const watchingEntry = stream?.entry ?? null;
    const watchingKey = watchingEntry?.infoHash ?? null;
    const pressure = this.#pressure(stream);
    this.pressure = pressure;
    const maxActive = settings.bandwidth.maxDownloads > 0 ? settings.bandwidth.maxDownloads : null;

    const ordered = this.ranked(queue);
    const activeTorrents = new Set();
    if (watchingKey) activeTorrents.add(watchingKey);
    const decisions = new Map();
    const now = Date.now();

    for (const item of ordered) {
      const key = Downloads.groupKey(item);
      const entry = this.entryOf(item);
      const found = this.fileOf(item, entry);
      const file = found?.file ?? null;
      const isWatching = stream && entry === watchingEntry && found && found.summary.index === stream.fileIndex;
      let decision;
      if (isWatching) decision = { download: false, state: 'watching' };
      else if (item.skipped) decision = { download: false, state: 'skipped' };
      else if (item.paused) decision = { download: false, state: 'paused' };
      else if (file && isComplete(file)) decision = { download: false, state: 'complete' };
      else if (!settings.bandwidth.backgroundDownloads) decision = { download: false, state: 'queued', waitReason: 'off' };
      else if (pressure === 'starving' && (!watchingKey || key !== watchingKey)) decision = { download: false, state: 'queued', waitReason: 'playback' };
      else if (maxActive !== null && !activeTorrents.has(key) && activeTorrents.size >= maxActive) decision = { download: false, state: 'queued', waitReason: 'limit' };
      else {
        activeTorrents.add(key);
        decision = { download: true };
      }
      decisions.set(item.id, { decision, entry, found, key });
    }

    // Reconcile the engine with the decisions.
    const wanted = new Map();
    for (const item of ordered) {
      const { decision, entry, found, key } = decisions.get(item.id);
      if (!decision.download) continue;
      if (!entry) {
        const failedAt = this.failed.get(key);
        if (failedAt && now < failedAt.until) continue;
        if (this.starting.has(key)) continue;
        if (this.starting.size >= MAX_STARTING) continue;
        this.#add(item, key);
        continue;
      }
      if (!entry.ready || !found) continue;
      if (!wanted.has(entry)) wanted.set(entry, new Set());
      wanted.get(entry).add(found.summary.index);
    }
    for (const entry of this.engine.entries.values()) {
      if (!entry.ready) continue;
      const want = wanted.get(entry) ?? new Set();
      for (const index of want) {
        if (!entry.bgSelected.has(index)) {
          try {
            const file = this.engine.file(entry, index);
            file.select(0);
            this.#startableFirst(entry, index, file);
            entry.bgSelected.add(index);
            entry.wake?.();
          } catch {
            // The torrent may have been removed under us.
          }
        }
      }
      for (const index of [...entry.bgSelected]) {
        if (!want.has(index)) {
          entry.bgSelected.delete(index);
          for (const focus of entry.bgFoci?.get(index) ?? []) removeFocus(entry.torrent, focus);
          entry.bgFoci?.delete(index);
          const isWatched = stream && entry === watchingEntry && index === stream.fileIndex;
          if (!isWatched) {
            try {
              this.engine.file(entry, index).deselect();
            } catch {
              // ignore
            }
          }
        }
      }
      this.#seeding(entry, queue, stream, settings);
    }

    // Snapshot for the queue rows.
    const byId = new Map();
    const items = queue.items.map((item) => byId.set(item.id, this.#describe(item, decisions.get(item.id), stream, pressure)).get(item.id));
    const totals = this.engine.totals();
    this.peaks.push({ at: now, bps: totals.downloadBps });
    this.peaks = this.peaks.filter((p) => now - p.at <= CAPACITY_WINDOW_MS);
    const capacity = Math.max(0, ...this.peaks.map((p) => p.bps));
    let playbackNeedBps = null;
    if (stream && stream.durationSecs > 0) playbackNeedBps = (stream.file.length / stream.durationSecs) * PLAYBACK_HEADROOM;
    const active = items.filter((d) => d.state === 'downloading' || d.state === 'connecting' || d.state === 'starting').length;
    this.snapshot = {
      items,
      link: {
        capacityBps: capacity,
        usedBps: totals.downloadBps,
        uploadBps: totals.uploadBps,
        active,
        maxActive,
        playbackNeedBps,
        pressure: pressure ?? 'relaxed',
      },
    };
  }

  /** Fetches a queued file's start and end before the rest (they are what playing needs first). */
  #startableFirst(entry, index, file) {
    const t = entry.torrent;
    if (!t?.pieceLength || file.length === 0) return;
    const first = Math.floor(file.offset / t.pieceLength);
    const last = Math.floor((file.offset + file.length - 1) / t.pieceLength);
    const foci = [addFocus(t, first, Math.min(last, first + focusPieces(t) - 1), STARTABLE_PRIORITY), addFocus(t, last, last, STARTABLE_PRIORITY)].filter(Boolean);
    entry.bgFoci ??= new Map();
    entry.bgFoci.set(index, foci);
  }

  #add(item, key) {
    const promise = this.engine
      .add(item.source, { infoHash: item.infoHash, origin: 'queue' })
      .then(() => this.failed.delete(key))
      .catch((err) => {
        this.failed.set(key, { until: Date.now() + RETRY_FAILED_MS, error: err?.message ?? String(err) });
      })
      .finally(() => this.starting.delete(key));
    this.starting.set(key, promise);
  }

  /** Keeps a finished torrent sharing until its target, then pauses it. */
  #seeding(entry, queue, stream, settings) {
    const t = entry.torrent;
    if (!t || t.destroyed) return;
    const watched = stream && stream.entry === entry;
    // Also a torrent watched before that a title page is getting ready to play again.
    const needed = watched || entry.bgSelected.size > 0 || entry.warming;
    if (needed) {
      entry.wake?.();
      entry.pausedForSeeding = false;
      return;
    }
    const b = settings.bandwidth;
    // Preloads and prefetches look after their own torrents until someone claims them.
    if (!entry.claimed && (entry.origin === 'preload' || entry.origin === 'prefetch')) return;
    // Not sharing: a torrent nothing watches or downloads holds no peers and uploads nothing,
    // whether it finished or was left halfway.
    if (!b.seedAfterWatching) {
      if (!entry.pausedForSeeding) {
        entry.pausedForSeeding = true;
        t.pause();
        for (const w of [...t.wires]) w.destroy();
      }
      return;
    }
    const inQueue = queue.items.some((i) => (i.infoHash ?? i.source) === (entry.infoHash ?? entry.source));
    const finishedSomething = entry.completedAt !== null || t.files.some((f) => f.length > 0 && downloadedOf(f) >= f.length);
    if (!finishedSomething && !inQueue) return;
    let done = !b.seedAfterWatching;
    if (!done && b.seedRatioTarget > 0 && t.ratio >= b.seedRatioTarget) done = true;
    if (!done && b.seedTimeLimitMinutes > 0 && entry.completedAt && Date.now() - entry.completedAt >= b.seedTimeLimitMinutes * 60_000) done = true;
    if (done && !entry.pausedForSeeding) {
      entry.pausedForSeeding = true;
      t.pause();
      for (const w of [...t.wires]) w.destroy();
    } else if (!done && b.seedAfterWatching && entry.pausedForSeeding) {
      entry.pausedForSeeding = false;
      t.resume();
    }
    if (!done && b.seedAfterWatching && !this.seedingStarted && t.uploadSpeed > 0) this.seedingStarted = true;
  }

  #describe(item, info, stream, pressure) {
    const d = {
      id: item.id,
      state: 'queued',
      downloadBps: 0,
      uploadBps: 0,
      peersLive: 0,
      peersConnecting: 0,
      peersSeen: 0,
      downloaded: 0,
      length: item.sizeBytes ?? null,
      etaSecs: null,
      startable: false,
      limited: false,
      waitReason: null,
      error: null,
    };
    if (!info) return d;
    const { decision, entry, found, key } = info;
    const t = entry?.torrent;
    if (t && !t.destroyed) {
      d.downloadBps = t.downloadSpeed;
      d.uploadBps = t.uploadSpeed;
      d.peersLive = t.numPeers;
      const seen = t._peersLength ?? t.numPeers;
      d.peersSeen = seen;
      d.peersConnecting = Math.max(0, seen - t.numPeers);
    }
    if (found) {
      d.length = found.summary.length;
      d.downloaded = downloadedOf(found.file);
      d.startable = startable(found.file);
    }
    const failed = this.failed.get(key);
    if (decision.state) {
      d.state = decision.state;
      d.waitReason = decision.waitReason ?? null;
    } else if (!entry) {
      if (failed) {
        d.state = 'failed';
        d.error = failed.error;
      } else d.state = this.starting.has(key) ? 'starting' : 'queued';
    } else if (!entry.ready) d.state = 'starting';
    else if (found && isComplete(found.file)) d.state = 'complete';
    else if (d.peersLive > 0 && d.downloadBps > 0) d.state = 'downloading';
    else d.state = 'connecting';
    if (d.state === 'downloading' && d.length) {
      const remaining = Math.max(0, d.length - d.downloaded);
      d.etaSecs = d.downloadBps >= 1024 ? remaining / d.downloadBps : null;
      d.limited = pressure === 'guarded' && stream && entry !== stream.entry;
    }
    if (d.state === 'watching' && d.length) {
      const remaining = Math.max(0, d.length - d.downloaded);
      d.etaSecs = d.downloadBps >= 1024 ? remaining / d.downloadBps : null;
    }
    return d;
  }

  /** The latest snapshot. */
  current() {
    return this.snapshot;
  }

  /** How ready each queued video is, for "Play ready videos first". */
  readiness(ids) {
    const want = new Set(ids);
    const out = [];
    for (const item of this.library.queue.items) {
      if (!want.has(item.id)) continue;
      const found = this.fileOf(item);
      if (!found) continue;
      const downloaded = downloadedOf(found.file);
      out.push({
        id: item.id,
        state: isComplete(found.file) ? 'complete' : startable(found.file) ? 'ready' : 'waiting',
        downloaded,
        length: found.summary.length,
      });
    }
    return out;
  }
}

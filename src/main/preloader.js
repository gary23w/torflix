// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Getting a video ready before Play is pressed: the start and the end of it are fetched quietly
// so Play starts at once. A title page warms up its copy as soon as it opens (on by default,
// `playback.warmUp`); a search's best pick and the Browse hero only with `search.preloadTopResult`.
// One at a time, never uploaded until played, and deleted if it is not played (unless it was
// played in an earlier session: a title page warms up its Resume, and that data is the viewer's).

import { EventEmitter } from 'node:events';
import { extensionOf, playTarget } from '../shared/files.js';
import { episodeFile } from '../shared/episodes.js';
import { addFocus, pieceRange, rangeVerified, removeFocus, downloadedOf } from './pieces.js';

/** Bytes of the start of the video to fetch. */
const HEAD_TARGET = 12 * 1024 * 1024;
/** Bytes of its end, where Matroska keeps its cues and many MP4s their index. */
const TAIL_TARGET = 2 * 1024 * 1024;
/** Containers a player reads the end of before it starts. */
const TAIL_FIRST = new Set(['mkv', 'mka', 'webm', 'mk3d', 'mp4', 'm4v', 'mov']);
const PRELOAD_PRIORITY = 2;
/** Around a resume point: a little before it (the keyframe the player starts from) and after. */
const RESUME_BEFORE = 2 * 1024 * 1024;
const RESUME_TARGET = 8 * 1024 * 1024;
/** The stream id the best pick's frame preview is served under (playback ids start at 1). */
const FRAME_STREAM_ID = 2_000_000_000;

export class Preloader extends EventEmitter {
  constructor({ engine, settings, server = null, library = null }) {
    super();
    this.engine = engine;
    this.settings = settings;
    this.server = server;
    this.library = library;
    this.current = null;
    /** A torrent Play was pressed on, even before a preload of it knew its metadata. */
    this.claimedHash = null;
    this.timer = setInterval(() => this.#tick(), 1000);
  }

  /** A loopback URL for a frame of the preloaded video, once its start and end are there. */
  frame() {
    const c = this.current;
    if (!c || c.phase !== 'ready' || !c.frameUrl) return null;
    return { infoHash: c.infoHash, url: c.frameUrl };
  }

  #serveFrame(c) {
    if (!this.server || !c.file || c.frameUrl) return;
    this.server.register({ id: FRAME_STREAM_ID, file: c.file, title: c.fileName ?? 'preview' });
    c.frameUrl = this.server.url(FRAME_STREAM_ID, c.fileName ?? 'preview');
  }

  #tailStart(c) {
    return c.withTail ? Math.max(0, c.file.length - TAIL_TARGET) : c.file.length;
  }

  status() {
    const c = this.current;
    if (!c) return null;
    const file = c.file;
    let bufferedBytes = 0;
    if (file) {
      const headEnd = Math.min(file.length - 1, HEAD_TARGET - 1);
      bufferedBytes = Math.min(downloadedOf(file), c.targetBytes);
      const tailStart = this.#tailStart(c);
      const resumeDone = !c.resumeRange || rangeVerified(file, c.resumeRange[0], c.resumeRange[1]);
      if (rangeVerified(file, 0, headEnd) && (tailStart >= file.length || rangeVerified(file, tailStart, file.length - 1)) && resumeDone) bufferedBytes = c.targetBytes;
    }
    return {
      infoHash: c.infoHash,
      phase: c.phase,
      reason: c.reason,
      owner: c.owner,
      claimed: c.entry?.claimed ?? false,
      fileIndex: c.fileIndex,
      fileName: c.fileName,
      bufferedBytes,
      targetBytes: c.targetBytes,
      progress: c.targetBytes > 0 ? Math.min(1, bufferedBytes / c.targetBytes) : 0,
      peers: c.entry?.torrent?.numPeers ?? 0,
      error: c.error,
    };
  }

  #allowed(reason) {
    const s = this.settings.settings;
    return reason === 'title' ? s.playback.warmUp : s.search.preloadTopResult;
  }

  /**
   * Starts getting a video ready; a different current one is dropped. `fileIndex` (or `pick`,
   * an episode in a season pack) says which file, else the torrent's main video. `owner` is the
   * title page that asked, so leaving it drops only its own.
   */
  async preload({ link, infoHash, reason = 'search', owner = null, fileIndex = null, pick = null, positionSecs = null, durationSecs = null }) {
    if (!this.#allowed(reason)) return this.status();
    const hash = infoHash?.toLowerCase() ?? null;
    const cur = this.current;
    if (cur && cur.infoHash === hash && cur.phase !== 'failed' && cur.fileIndex === (fileIndex ?? cur.fileIndex) && !pick === !cur.pick && cur.positionSecs === positionSecs) {
      cur.owner = owner;
      cur.reason = reason;
      return this.status();
    }
    await this.cancel();
    const c = { infoHash: hash, link, reason, owner, pick, positionSecs, resumeRange: null, phase: 'resolving', entry: null, file: null, fileIndex: null, fileName: null, withTail: false, targetBytes: 0, error: null, ranges: [], frameUrl: null };
    this.current = c;
    this.emit('status', this.status());
    try {
      const entry = await this.engine.add(link, { infoHash: hash, origin: 'preload' });
      if (this.current !== c) {
        // Dropped while its metadata was being found: deleted, unless Play wants it now.
        if (!entry.claimed && entry.origin === 'preload' && this.claimedHash !== entry.infoHash) this.engine.remove(entry, { destroyStore: !this.#watched(entry) }).catch(() => {});
        return this.status();
      }
      c.entry = entry;
      c.infoHash = entry.infoHash;
      // Kept connected while it gets ready, even if it was quieted after an earlier watch.
      entry.warming = this.claimedHash !== entry.infoHash;
      if (this.claimedHash === entry.infoHash) entry.claim();
      const files = this.engine.files(entry);
      const target = (fileIndex !== null ? files.find((f) => f.index === fileIndex) : null) ?? (pick ? episodeFile(files, pick.season, pick.episode) : null) ?? playTarget(files);
      if (!target) throw new Error('nothing to play');
      const file = this.engine.file(entry, target.index);
      c.file = file;
      c.fileIndex = target.index;
      c.fileName = target.path;
      c.withTail = TAIL_FIRST.has(extensionOf(target.path));
      const headEnd = Math.min(file.length - 1, HEAD_TARGET - 1);
      const tailStart = this.#tailStart(c);
      c.targetBytes = Math.min(file.length, headEnd + 1 + (file.length - tailStart));
      // Exact selections: a merged one would lift the whole file (if queued) to this priority.
      const [ha, hb] = pieceRange(file, 0, headEnd);
      c.ranges.push(addFocus(file._torrent, ha, hb, PRELOAD_PRIORITY));
      if (tailStart > headEnd && tailStart < file.length) {
        const [ta, tb] = pieceRange(file, tailStart, file.length - 1);
        c.ranges.push(addFocus(file._torrent, ta, tb, PRELOAD_PRIORITY));
      }
      // Resuming: where it was left too (its place in the file, from the time and the length).
      if (positionSecs > 0 && durationSecs > positionSecs) {
        const at = Math.floor((positionSecs / durationSecs) * file.length);
        const from = Math.max(headEnd + 1, at - RESUME_BEFORE);
        const to = Math.min(tailStart - 1, at + RESUME_TARGET);
        if (to > from) {
          const [ra, rb] = pieceRange(file, from, to);
          c.ranges.push(addFocus(file._torrent, ra, rb, PRELOAD_PRIORITY));
          c.resumeRange = [from, to];
          c.targetBytes += to - from + 1;
        }
      }
      c.phase = 'buffering';
    } catch (err) {
      if (this.current === c) {
        c.phase = 'failed';
        c.error = err?.message ?? String(err);
      }
    }
    this.emit('status', this.status());
    return this.status();
  }

  #tick() {
    const c = this.current;
    if (!c || c.phase !== 'buffering' || !c.file) return;
    if (c.entry?.torrent?.paused) c.entry.wake?.();
    const s = this.status();
    if (s.bufferedBytes >= c.targetBytes) {
      c.phase = 'ready';
      this.#serveFrame(c);
      this.emit('status', this.status());
    } else if (s.progress - (c.shownProgress ?? 0) >= 0.1) {
      // Progress for the page that asked (a title page shows it), in tenths, not every second.
      c.shownProgress = s.progress;
      this.emit('status', s);
    }
  }

  /**
   * Play was pressed on this torrent: it is the viewer's now, nothing is deleted, and it uploads
   * like any torrent played. Works before a preload of it knows its metadata too.
   */
  claim(infoHash) {
    this.claimedHash = infoHash;
    const c = this.current;
    if (c && c.infoHash === infoHash && c.entry) {
      c.entry.claim();
      // What plays it decides from here whether it stays connected.
      c.entry.warming = false;
    }
  }

  /** Played before, in this session or an earlier one: dropping a preload of it keeps its data. */
  #watched(entry) {
    return Boolean(entry.infoHash && this.library?.watched(entry.infoHash));
  }

  /**
   * Drops the current preload (only `owner`'s, when given): its data is deleted unless the
   * viewer played the torrent, now or before.
   */
  async cancel({ owner } = {}) {
    const c = this.current;
    if (!c) return;
    if (owner !== undefined && c.owner !== owner) return;
    this.current = null;
    if (c.entry) c.entry.warming = false;
    if (c.phase === 'buffering' || c.phase === 'ready') c.phase = 'cancelled';
    if (c.frameUrl) this.server?.unregister(FRAME_STREAM_ID);
    if (c.file) for (const r of c.ranges) removeFocus(c.file._torrent, r);
    if (c.entry && !c.entry.claimed && this.claimedHash !== c.entry.infoHash) {
      await this.engine.remove(c.entry, { destroyStore: !this.#watched(c.entry) }).catch(() => {});
    }
    this.emit('status', null);
  }

  destroy() {
    clearInterval(this.timer);
    return this.cancel();
  }
}

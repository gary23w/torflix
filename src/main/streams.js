// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Playback streams: opening a file of a torrent for the player, its live statistics, playback
// reports (resume positions), and the subtitles in its torrent.

import { Buffer } from 'node:buffer';
import { extensionOf, fileName, fileKind, playTarget, sortFiles } from '../shared/files.js';
import { episodeFile, episodeTag } from '../shared/episodes.js';
import { describeSubtitle, parseSubtitles, decodeSubtitleBytes, cuesToSrt, MAX_SUBTITLE_BYTES } from '../shared/subtitles.js';
import { addFocus, bufferedAfter, downloadedOf, pieceMap, removeFocus, PIECE_MAP_CELLS } from './pieces.js';
import { EngineError } from './engine.js';
import { chooseTrack } from './media-tools.js';

/**
 * Priority of the rest of the file being watched: the same as background downloads, and below
 * the player's own reads (1) and the pieces at the playhead (3). WebTorrent serves equal
 * priorities in turn, so at 1 the whole file shared the connection with the player's reads.
 */
const WATCH_PRIORITY = 0;
const SUBTITLE_TIMEOUT_MS = 60_000;
/** How long a subtitle file asked for by address waits for the video's first frame. */
const SUBTITLE_AFTER_MS = 8000;
/**
 * The end of a file the player reads before it starts (a Matroska file's cues and tags, an MP4's
 * index when it is at the end): it is fetched together with the start, not after it. Measured:
 * Chromium asks for the last few kilobytes of an MKV right after its header, and waits for them.
 */
const TAIL_BYTES = 2 * 1024 * 1024;
/**
 * The start of the file fetched before the player asks: only what opening it needs. On a slow
 * swarm every extra piece in flight slows the first one; the focus that follows the player's
 * reads takes over from there.
 */
const OPEN_HEAD_BYTES = 4 * 1024 * 1024;
/** Matroska keeps its cues at the end, and the player reads them before it starts. */
const TAIL_FIRST = new Set(['mkv', 'mka', 'webm', 'mk3d']);
/**
 * An MP4's index is at its start (most copies played: the player never asked for the end) or at
 * its end. The end is fetched with what the start leaves over, not alongside it: with large
 * pieces it was a whole piece more before the first frame. If the index is there, the player's
 * own request for it puts it first.
 */
const TAIL_SPARE = new Set(['mp4', 'm4v', 'mov']);
const TAIL_SPARE_PRIORITY = 1;

let nextStreamId = 1;

export class Streams {
  constructor({ engine, server, library, settings, media = null }) {
    this.engine = engine;
    this.server = server;
    this.library = library;
    this.settings = settings;
    this.media = media;
    /** @type {Map<number, any>} */
    this.streams = new Map();
    /** Counts starts: a start overtaken by a newer one gives up instead of replacing it. */
    this.startSeq = 0;
    /**
     * `(streamId, reason)` after a stream closes: 'request' (the window asked), 'replaced' (another
     * video started), 'removed' (its torrent went away), 'quit'. The window clears its player
     * for any but 'request': a stream closed under it answers 404, which the video element
     * would report as a file it cannot play.
     */
    this.onStopped = null;
  }

  /** The one stream open, if any (the player keeps it while the user looks elsewhere). */
  active() {
    for (const s of this.streams.values()) return s;
    return null;
  }

  /**
   * Opens a file for playback. `fileIndex` null plays the torrent's main video (or an album's
   * first track), or with `pick` that episode of a season pack. `positionSecs` says where to
   * start (0: the start); unsaid, the saved position is used. Any other stream is closed first:
   * playing something else closes it.
   */
  async start({ source, bytes = null, fileIndex = null, infoHash = null, pick = null, positionSecs = undefined }) {
    const seq = ++this.startSeq;
    const t0 = Date.now();
    // Another torrent playing stops now, not once this one's metadata is in: until then it
    // would keep downloading its whole file, slowing this start down.
    for (const [id, open] of [...this.streams]) if (!infoHash || open.infoHash !== infoHash) this.stop(id, 'replaced');
    const entry = await this.engine.add(source, { bytes, infoHash, origin: 'user' });
    // Pressing Play on something else while this one was being found: that one wins.
    if (seq !== this.startSeq) throw new EngineError('superseded', 'Another video was started meanwhile.');
    const files = this.engine.files(entry);
    let target;
    if (fileIndex !== null) target = files.find((f) => f.index === fileIndex) ?? null;
    else if (pick) {
      target = episodeFile(files, pick.season, pick.episode);
      if (!target) throw new EngineError('noEpisode', `This copy has no ${episodeTag(pick.season, pick.episode)}.`);
    } else target = playTarget(files);
    if (!target) throw new EngineError('noVideo', 'This torrent has no video or audio file to play.');
    if (target.kind !== 'video' && target.kind !== 'audio') throw new EngineError('notPlayable', 'That file is not a video or audio file.');
    if (this.engine.debug) console.log(`[timing] start ${entry.infoHash.slice(0, 8)}: metadata +${Date.now() - t0} ms, file ${target.index}`);
    // Play on what is already playing keeps it: no new stream, no second start.
    for (const open of this.streams.values()) {
      if (open.entry === entry && open.fileIndex === target.index) return this.#info(open, target);
    }
    for (const id of [...this.streams.keys()]) this.stop(id, 'replaced');

    // Quieted after an earlier watch (not sharing): reconnect at once, not on the next tick.
    entry.wake?.();
    const file = this.engine.file(entry, target.index);
    file.select(WATCH_PRIORITY);
    entry.lastUsedAt = Date.now();
    const id = nextStreamId++;
    const title = fileName(target.path);
    const stream = {
      id,
      entry,
      file,
      fileIndex: target.index,
      infoHash: entry.infoHash,
      title,
      torrentName: entry.name,
      kind: target.kind,
      startedAt: Date.now(),
      durationSecs: null,
      positionSecs: 0,
      seeks: 0,
      firstFrameMs: null,
      lastSeekMs: null,
      revision: 0,
      subtitleSelections: new Map(),
    };
    this.streams.set(id, stream);
    this.server.register({ id, file, title });
    this.library.opened({
      infoHash: entry.infoHash,
      fileIndex: target.index,
      source: this.engine.magnetOf(entry),
      title,
      torrentName: entry.name,
      sizeBytes: target.length,
    });
    if (positionSecs !== undefined) {
      // Chosen on the title page: Resume from there, or Play from start.
      stream.resumeSecs = positionSecs > 0 ? positionSecs : null;
      stream.resumeChosen = true;
    } else {
      stream.resumeSecs = this.settings.settings.playback.resumePosition ? this.library.resumePosition(entry.infoHash, target.index) : null;
      stream.resumeChosen = false;
    }
    // The start of the file is fetched first, before the player's first request even arrives,
    // and so is the resume point when it is known.
    const torrent = entry.torrent;
    const pieceAt = (byte) => Math.floor((file.offset + Math.min(Math.max(0, byte), Math.max(0, file.length - 1))) / torrent.pieceLength);
    stream.foci = [addFocus(torrent, pieceAt(0), pieceAt(OPEN_HEAD_BYTES - 1))];
    const ext = extensionOf(file.path);
    if (TAIL_FIRST.has(ext)) stream.foci.push(addFocus(torrent, pieceAt(file.length - TAIL_BYTES), pieceAt(file.length - 1)));
    else if (TAIL_SPARE.has(ext)) stream.foci.push(addFocus(torrent, pieceAt(file.length - TAIL_BYTES), pieceAt(file.length - 1), TAIL_SPARE_PRIORITY, { critical: false }));
    const known = this.library.get(entry.infoHash, target.index);
    if (stream.resumeSecs && known?.durationSecs > 0) {
      const at = (stream.resumeSecs / known.durationSecs) * file.length;
      stream.foci.push(addFocus(torrent, pieceAt(at), pieceAt(at + OPEN_HEAD_BYTES - 1)));
    }
    return this.#info(stream, target);
  }

  #info(stream, target) {
    return {
      streamId: stream.id,
      url: this.server.url(stream.id, stream.title),
      fileName: stream.title,
      length: target.length,
      resumePositionSecs: stream.resumeSecs ?? null,
      // The page chose where to start: the player does not ask again.
      resumeChosen: stream.resumeChosen === true,
      // Its subtitle files, so the TV's player gets them with the video, no second request.
      subtitles: this.#subtitleFiles(stream.id),
      torrentId: stream.entry.id,
      fileIndex: target.index,
      infoHash: stream.entry.infoHash,
      torrentName: stream.entry.name,
      kind: target.kind,
    };
  }

  stop(id, reason = 'request') {
    const s = this.streams.get(id);
    if (!s) return;
    if (this.engine.debug) console.log(`[streams] stop ${id} (${s.title})\n${new Error('from').stack.split('\n').slice(2, 6).join('\n')}`);
    this.server.unregister(id);
    this.streams.delete(id);
    for (const focus of s.foci ?? []) removeFocus(s.entry.torrent, focus);
    try {
      this.onStopped?.(id, reason);
    } catch {
      // the window is gone
    }
    // The background downloader decides whether the file keeps downloading; here only the
    // playback priority is dropped. A file nobody queued stops.
    if (!s.entry.bgSelected.has(s.fileIndex)) {
      try {
        s.file.deselect();
      } catch {
        // gone already
      }
    }
    s.entry.lastUsedAt = Date.now();
  }

  get(id) {
    return this.streams.get(id) ?? null;
  }

  /** Live statistics, polled about once a second by the player. */
  stats(id) {
    const s = this.streams.get(id);
    if (!s) throw new EngineError('noSuchStream', 'That stream is closed.');
    const t = s.entry.torrent;
    const srv = this.server.status(id);
    const position = srv?.positionBytes ?? 0;
    const bufferedBytes = bufferedAfter(s.file, position);
    const fileLength = s.file.length;
    const byteRate = s.durationSecs && s.durationSecs > 0 ? fileLength / s.durationSecs : null;
    const downloaded = downloadedOf(s.file);
    const seen = t._peersLength ?? t.numPeers;
    return {
      state: t.destroyed ? 'error' : t.ready ? 'live' : 'initializing',
      downloadBps: t.downloadSpeed,
      /** Bytes received from peers so far, checked or not: whether this copy sends anything. */
      receivedBytes: t.received ?? 0,
      uploadBps: t.uploadSpeed,
      peersLive: t.numPeers,
      peersConnecting: Math.max(0, seen - t.numPeers),
      peersSeen: seen,
      fileLength,
      fileDownloaded: downloaded,
      positionBytes: position,
      bufferedBytes,
      bufferedSecs: byteRate ? bufferedBytes / byteRate : null,
      anchors: [{ offset: position, purpose: 'playhead' }],
      pieceMap: pieceMap(s.file, PIECE_MAP_CELLS),
      serverFirstByteMs: srv?.firstByteMs ?? null,
      firstFrameMs: s.firstFrameMs,
      lastSeekMs: s.lastSeekMs,
      seeks: s.seeks,
      engine: 'webtorrent',
    };
  }

  /** A playback report: position, duration, the end of the video, player timings. */
  report(id, { positionSecs, durationSecs, ended = false, seek = false, firstFrameMs, lastSeekMs }) {
    const s = this.streams.get(id);
    if (!s) return;
    if (Number.isFinite(durationSecs) && durationSecs > 0) s.durationSecs = durationSecs;
    if (Number.isFinite(positionSecs) && positionSecs >= 0) s.positionSecs = positionSecs;
    if (seek) s.seeks += 1;
    if (Number.isFinite(firstFrameMs)) {
      s.firstFrameMs = firstFrameMs;
      s.onFirstFrame?.();
    }
    if (Number.isFinite(lastSeekMs)) s.lastSeekMs = lastSeekMs;
    s.revision += 1;
    this.library.progress(s.infoHash, s.fileIndex, { positionSecs: s.positionSecs, durationSecs: s.durationSecs, ended, revision: s.revision });
  }

  /**
   * The stream's audio tracks and whether the player must play converted audio: when the
   * track to play is in a format the built-in player cannot decode (Dolby, DTS) and FFmpeg is
   * there. Without ffprobe nothing is known (`probed: false`).
   */
  async audio(id, languages = []) {
    const s = this.streams.get(id);
    if (!s) throw new EngineError('noSuchStream', 'That stream is closed.');
    const tools = this.media ? await this.media.tools() : { ffmpeg: null, ffprobe: null };
    const base = { ffmpeg: Boolean(tools.ffmpeg), probed: false, tracks: [], chosen: null, needsConversion: false, convert: false, url: null };
    if (!tools.ffprobe) return base;
    s.audioProbe ??= this.media.probeAudio(this.server.internalUrl(id)).catch((err) => {
      console.error(`[audio] probe failed: ${err?.message ?? err}`);
      return null;
    });
    const tracks = await s.audioProbe;
    if (!this.streams.has(id) || tracks === null) return base;
    const chosen = chooseTrack(tracks, languages);
    const track = chosen === null ? null : tracks[chosen];
    const needsConversion = Boolean(track && !track.decodes);
    const convert = needsConversion && Boolean(tools.ffmpeg);
    return { ...base, probed: true, tracks, chosen, needsConversion, convert, url: convert ? this.server.audioUrl(id) : null };
  }

  /** Subtitle files in the stream's torrent, the video's own first. */
  subtitles(id) {
    const s = this.streams.get(id);
    if (!s) throw new EngineError('noSuchStream', 'That stream is closed.');
    const files = this.engine.files(s.entry);
    const videoCount = files.filter((f) => f.kind === 'video').length;
    const videoPath = files.find((f) => f.index === s.fileIndex)?.path ?? s.title;
    const list = sortFiles(files.filter((f) => f.kind === 'subtitle' && /\.(srt|vtt|ass|ssa)$/i.test(f.path)))
      .map((f) => ({ ...describeSubtitle(f, videoPath, videoCount), url: this.server.subtitleUrl?.(id, f.index) ?? null }))
      .sort((a, b) => Number(b.matched) - Number(a.matched) || a.label.localeCompare(b.label));
    return { files: list, embedded: [] };
  }

  #subtitleFiles(id) {
    try {
      return this.subtitles(id).files;
    } catch {
      return [];
    }
  }

  /**
   * One of the stream's subtitle files as SRT, for a player that loads it by address (the TV's).
   * It is fetched once the video shows (or after a few seconds): fetched before, it would compete
   * with the video's first piece for the swarm.
   */
  async subtitleSrt(id, fileIndex) {
    const s = this.streams.get(id);
    if (!s) throw new EngineError('noSuchStream', 'That stream is closed.');
    if (s.firstFrameMs === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, SUBTITLE_AFTER_MS);
        s.onFirstFrame = () => (clearTimeout(timer), resolve());
      });
    }
    const parsed = await this.loadSubtitles(id, fileIndex);
    return cuesToSrt(parsed.cues);
  }

  /** Downloads and parses one subtitle file of the stream's torrent. */
  async loadSubtitles(id, fileIndex) {
    const s = this.streams.get(id);
    if (!s) throw new EngineError('noSuchStream', 'That stream is closed.');
    const file = this.engine.file(s.entry, fileIndex);
    if (fileKind(file.path) !== 'subtitle') throw new EngineError('notSubtitle', 'That file is not a subtitle file.');
    if (file.length > MAX_SUBTITLE_BYTES) throw new EngineError('tooLarge', 'That subtitle file is larger than 5 MiB.');
    const bytes = await withTimeout(file.arrayBuffer(), SUBTITLE_TIMEOUT_MS, 'The subtitle file did not arrive in time.');
    return parseSubtitles(decodeSubtitleBytes(new Uint8Array(bytes)), file.name);
  }

  /** Parses a subtitle file the user chose on this computer. */
  parseLocal(bytes, name) {
    if (bytes.byteLength > MAX_SUBTITLE_BYTES) throw new EngineError('tooLarge', 'That subtitle file is larger than 5 MiB.');
    return parseSubtitles(decodeSubtitleBytes(Buffer.from(bytes)), name);
  }

  stopAll(reason = 'quit') {
    for (const id of [...this.streams.keys()]) this.stop(id, reason);
  }

  /** Closes the streams of a torrent that went away (removed, or lost in an engine restart). */
  stopEntry(entry) {
    for (const s of [...this.streams.values()]) if (s.entry === entry) this.stop(s.id, 'removed');
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineError('timeout', message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

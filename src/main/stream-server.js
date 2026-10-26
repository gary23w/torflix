// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The loopback HTTP range server the `<video>` element reads from. Each stream has a numeric id
// and every URL carries a per-run secret token, so nothing else on the machine can read the
// files. Each range request starts a WebTorrent read at that offset, and the pieces right
// after the position the player asked for are fetched before anything else (a focus that
// follows the read): that is what makes starting and skipping fast.

import http from 'node:http';
import crypto from 'node:crypto';
import { extensionOf, mimeOf } from '../shared/files.js';
import { MovingFocus } from './pieces.js';

/** Readers inside the app (the audio check, the converter) come right after the playhead. */
const INTERNAL_FOCUS_PRIORITY = 2;

const MAX_PENDING_PER_STREAM = 6;
/** Readers inside the app (ffprobe, the audio converter) get their own allowance. */
const MAX_PENDING_INTERNAL = 4;

/** Content types Chromium accepts for `<video>`; Matroska plays through the WebM demuxer. */
function contentType(path) {
  const ext = extensionOf(path);
  if (ext === 'mkv' || ext === 'mka') return 'video/webm';
  if (ext === 'mov') return 'video/mp4';
  return mimeOf(path);
}

export class StreamServer {
  constructor() {
    this.token = crypto.randomBytes(16).toString('hex');
    this.port = 0;
    this.server = null;
    /** @type {Map<number, {id:number, file:any, title:string, positionBytes:number, firstByteMs:number|null, requests:number, lastRequestAt:number, pending:Set<any>}>} */
    this.streams = new Map();
    /** `({ input, start, track }) => ChildProcess | null`: the audio converter, when FFmpeg is there. */
    this.convertAudio = null;
    /** The running audio conversion of each stream (one at a time). */
    this.conversions = new Map();
    /** Logs every range request and how long its first byte took (`--dev`). */
    this.debug = Boolean(process.env.TORRENTPLAYER_DEBUG) || process.argv.includes('--dev');
  }

  listen() {
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else res.destroy();
        if (err?.code !== 'ERR_STREAM_DESTROYED') console.error('[stream] request failed:', err?.message ?? err);
      });
    });
    this.server.keepAliveTimeout = 65_000;
    this.server.on('clientError', (_err, socket) => socket.destroy());
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  register(stream) {
    this.streams.set(stream.id, {
      id: stream.id,
      file: stream.file,
      title: stream.title,
      positionBytes: 0,
      firstByteMs: null,
      requests: 0,
      lastRequestAt: 0,
      pending: new Set(),
      internal: new Set(),
    });
  }

  unregister(id) {
    const s = this.streams.get(id);
    if (!s) return;
    for (const res of s.pending) res.destroy();
    for (const res of s.internal) res.destroy();
    this.conversions.get(id)?.kill('SIGKILL');
    this.conversions.delete(id);
    this.streams.delete(id);
  }

  status(id) {
    return this.streams.get(id) ?? null;
  }

  url(id, name) {
    const safe = encodeURIComponent(name.replace(/[^\p{L}\p{N}._-]+/gu, '_')).slice(0, 120) || 'media';
    return `http://127.0.0.1:${this.port}/s/${this.token}/${id}/${safe}`;
  }

  /** The same file for readers inside the app: they do not move the player's playhead. */
  internalUrl(id) {
    return `http://127.0.0.1:${this.port}/i/${this.token}/${id}/media`;
  }

  /** Converted audio of a stream; the player adds `?t=<seconds>&track=<n>`. */
  audioUrl(id) {
    return `http://127.0.0.1:${this.port}/a/${this.token}/${id}`;
  }

  /** One of a stream's subtitle files, as SRT (see `subtitleSrt`, set by core.js). */
  subtitleUrl(id, fileIndex) {
    return `http://127.0.0.1:${this.port}/t/${this.token}/${id}/${fileIndex}.srt`;
  }

  /**
   * A subtitle file: the answer starts at once, so the player opening it waits for nothing, and
   * its text follows when it is in (empty if it never comes: a subtitle never stops a video).
   */
  async #subtitle(res, t) {
    if (t[1] !== this.token || !this.streams.has(Number(t[2])) || !this.subtitleSrt) {
      res.statusCode = 404;
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8' });
    res.flushHeaders();
    let text = '';
    try {
      text = await this.subtitleSrt(Number(t[2]), Number(t[3]));
    } catch (err) {
      if (this.debug) console.log(`[stream] subtitle ${t[2]}/${t[3]}: ${err?.message ?? err}`);
    }
    res.end(text);
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const a = /^\/a\/([0-9a-f]{32})\/(\d+)$/.exec(url.pathname);
    if (a) return this.#audio(req, res, a, url.searchParams);
    const t = /^\/t\/([0-9a-f]{32})\/(\d+)\/(\d+)\.srt$/.exec(url.pathname);
    if (t) return this.#subtitle(res, t);
    const m = /^\/([si])\/([0-9a-f]{32})\/(\d+)(?:\/[^/]*)?$/.exec(url.pathname);
    if (!m || m[2] !== this.token) {
      res.statusCode = 403;
      return res.end();
    }
    const internal = m[1] === 'i';
    const stream = this.streams.get(Number(m[3]));
    if (!stream || !stream.file || stream.file._destroyed) {
      res.statusCode = 404;
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    const file = stream.file;
    const length = file.length;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType(file.path));

    let start = 0;
    let end = length - 1;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!r || (r[1] === '' && r[2] === '')) return rangeError(res, length);
      if (r[1] === '') {
        const suffix = Number(r[2]);
        start = Math.max(0, length - suffix);
      } else {
        start = Number(r[1]);
        if (r[2] !== '') end = Math.min(Number(r[2]), length - 1);
      }
      if (!Number.isFinite(start) || start >= length || start > end) return rangeError(res, length);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${length}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD' || length === 0) return res.end();

    const pending = internal ? stream.internal : stream.pending;
    if (!internal) {
      stream.requests += 1;
      stream.lastRequestAt = Date.now();
      stream.positionBytes = start;
    }
    if (pending.size >= (internal ? MAX_PENDING_INTERNAL : MAX_PENDING_PER_STREAM)) {
      // Chromium opens a fresh request on every seek; old ones are abandoned, so drop the oldest.
      const oldest = pending.values().next().value;
      oldest?.destroy();
    }
    pending.add(res);
    const t0 = Date.now();
    const pieceLength = file._torrent?.pieceLength ?? 0;
    const pieceOf = (byte) => (pieceLength ? Math.floor((file.offset + byte) / pieceLength) : 0);
    const tag = `[stream] ${stream.id}${internal ? ' internal' : ''} ${start}-${end} (piece ${pieceOf(start)}${file._torrent?.bitfield?.get(pieceOf(start)) ? ', on disk' : ''})`;
    let sent = 0;
    if (this.debug) console.log(`${tag} requested`);
    // The player waits on these bytes: their pieces go first. Readers inside the app come next.
    const focus = new MovingFocus(file, internal ? INTERNAL_FOCUS_PRIORITY : undefined);
    focus.moveTo(start);
    let closed = false;
    res.on('close', () => {
      closed = true;
      pending.delete(res);
    });

    const source = file[Symbol.asyncIterator]({ start, end });
    const iterator = typeof source.next === 'function' ? source : source[Symbol.asyncIterator]();
    let first = true;
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || closed) break;
        if (first) {
          first = false;
          if (!internal) stream.firstByteMs = Date.now() - t0;
          if (this.debug) console.log(`${tag} first byte after ${Date.now() - t0} ms`);
        }
        sent += value.length;
        focus.moveTo(start + sent);
        if (!res.write(value)) {
          await new Promise((resolve) => {
            const onDrain = () => {
              res.removeListener('close', onClose);
              resolve();
            };
            const onClose = () => {
              res.removeListener('drain', onDrain);
              resolve();
            };
            res.once('drain', onDrain);
            res.once('close', onClose);
          });
        }
      }
    } finally {
      if (typeof iterator.return === 'function') iterator.return().catch?.(() => {});
      focus.clear();
      pending.delete(res);
      if (!closed) res.end();
      if (this.debug) console.log(`${tag} ${closed ? 'closed by the reader' : 'finished'} after ${Date.now() - t0} ms, ${(sent / 1048576).toFixed(1)} MiB sent`);
    }
  }

  /**
   * Converted audio: FFmpeg reads the stream's file through the internal URL from `t` seconds
   * and sends AAC as it goes. A new request for a stream (a seek) replaces the running one.
   */
  #audio(req, res, m, params) {
    if (m[1] !== this.token) {
      res.statusCode = 403;
      return res.end();
    }
    const id = Number(m[2]);
    const stream = this.streams.get(id);
    if (!stream || !this.convertAudio) {
      res.statusCode = 404;
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    const start = Math.min(Math.max(Number(params.get('t')) || 0, 0), 1e6);
    const track = Math.min(Math.max(Math.trunc(Number(params.get('track')) || 0), 0), 64);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/aac');
    if (req.method === 'HEAD') return res.end();
    this.conversions.get(id)?.kill('SIGKILL');
    const child = this.convertAudio({ input: this.internalUrl(id), start, track });
    if (!child) {
      res.statusCode = 503;
      return res.end();
    }
    this.conversions.set(id, child);
    let err = '';
    child.stderr.on('data', (d) => {
      if (err.length < 4000) err += d;
    });
    child.on('error', () => res.destroy());
    child.on('close', (code) => {
      if (this.conversions.get(id) === child) this.conversions.delete(id);
      if (code && code !== 255 && err.trim()) console.error(`[audio] conversion ended (${code}): ${err.trim().split('\n').pop()}`);
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => child.kill('SIGKILL'));
    child.stdout.pipe(res);
  }

  close() {
    for (const id of [...this.streams.keys()]) this.unregister(id);
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function rangeError(res, length) {
  res.statusCode = 416;
  res.setHeader('Content-Range', `bytes */${length}`);
  res.end();
}

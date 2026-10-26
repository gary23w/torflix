// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Resume data, so adding a torrent again is instant: its metadata (a .torrent file, so no peer
// has to send it again) and which of its pieces are on disk (WebTorrent then checks one piece
// per file instead of hashing everything already downloaded, which takes minutes on big
// files). One pair of files per torrent in <userData>/resume, written atomically.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const HASH_RE = /^[0-9a-f]{40}$/;
/** How often a downloading torrent's piece map is saved. */
const SAVE_EVERY_MS = 15_000;
/** Resume pairs kept; the least recently used go first. */
const KEEP = 400;

export class ResumeStore {
  constructor(dir) {
    this.dir = dir;
    /** Pending piece-map saves, by info hash. */
    this.timers = new Map();
    this.ready = fsp.mkdir(dir, { recursive: true }).catch(() => {});
  }

  #path(infoHash, ext) {
    return path.join(this.dir, `${infoHash}.${ext}`);
  }

  /**
   * `{ torrentFile, bitfield }` of a torrent; each is null when not saved. Synchronous (the
   * files are a few kilobytes), so adding a torrent gains no wait a second add could race.
   */
  load(infoHash) {
    const none = { torrentFile: null, bitfield: null };
    if (!HASH_RE.test(infoHash ?? '')) return none;
    const read = (ext) => {
      try {
        return fs.readFileSync(this.#path(infoHash, ext));
      } catch {
        return null;
      }
    };
    const torrentFile = read('torrent');
    const bitfield = torrentFile ? read('bitfield') : null;
    if (torrentFile) {
      // Touch it, so pruning keeps what is used.
      const now = new Date();
      fsp.utimes(this.#path(infoHash, 'torrent'), now, now).catch(() => {});
    }
    return { torrentFile, bitfield };
  }

  /** Saves a torrent's metadata once it is known. */
  async saveMetadata(torrent) {
    const hash = torrent?.infoHash;
    if (!HASH_RE.test(hash ?? '') || !torrent.torrentFile) return;
    await this.ready;
    const file = this.#path(hash, 'torrent');
    if (fs.existsSync(file)) return;
    await writeAtomic(file, torrent.torrentFile);
  }

  /** Saves which pieces are on disk now. */
  async saveBitfield(torrent) {
    const hash = torrent?.infoHash;
    if (!HASH_RE.test(hash ?? '') || !torrent.bitfield || !Array.isArray(torrent.pieces) || torrent.pieces.length === 0) return;
    clearTimeout(this.timers.get(hash));
    this.timers.delete(hash);
    const bytes = Math.ceil(torrent.pieces.length / 8);
    const buf = Buffer.from(torrent.bitfield.buffer.subarray(0, bytes));
    if (buf.length !== bytes) return;
    await this.ready;
    await writeAtomic(this.#path(hash, 'bitfield'), buf);
  }

  /** Saves the piece map soon (at most every few seconds while pieces arrive). */
  scheduleBitfield(torrent) {
    const hash = torrent?.infoHash;
    if (!hash || this.timers.has(hash)) return;
    const timer = setTimeout(() => {
      this.timers.delete(hash);
      if (!torrent.destroyed) this.saveBitfield(torrent).catch(() => {});
    }, SAVE_EVERY_MS);
    timer.unref?.();
    this.timers.set(hash, timer);
  }

  /** Keeps a torrent's resume data current: metadata now, the piece map as pieces arrive. */
  track(torrent) {
    const onMetadata = () => this.saveMetadata(torrent).catch(() => {});
    if (torrent.metadata) onMetadata();
    else torrent.once('metadata', onMetadata);
    torrent.on('verified', () => this.scheduleBitfield(torrent));
    // The first check of data already on disk is the expensive one: keep its result at once.
    torrent.once('ready', () => this.saveBitfield(torrent).catch(() => {}));
    torrent.once('done', () => this.saveBitfield(torrent).catch(() => {}));
  }

  /** Saves the piece maps of these torrents now (before quitting or removing). */
  async flush(torrents) {
    await Promise.all(torrents.filter((t) => t && !t.destroyed && t.ready).map((t) => this.saveBitfield(t).catch(() => {})));
  }

  /** Forgets a torrent whose data was deleted. */
  async forget(infoHash) {
    if (!HASH_RE.test(infoHash ?? '')) return;
    clearTimeout(this.timers.get(infoHash));
    this.timers.delete(infoHash);
    await Promise.all(['torrent', 'bitfield'].map((ext) => fsp.rm(this.#path(infoHash, ext), { force: true }).catch(() => {})));
  }

  /** Drops the least recently used pairs beyond the limit. */
  async prune(keep = KEEP) {
    await this.ready;
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    const hashes = names.filter((n) => n.endsWith('.torrent')).map((n) => n.slice(0, -'.torrent'.length)).filter((h) => HASH_RE.test(h));
    if (hashes.length <= keep) return;
    const dated = await Promise.all(hashes.map(async (h) => ({ h, at: (await fsp.stat(this.#path(h, 'torrent')).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.at - a.at);
    for (const { h } of dated.slice(keep)) await this.forget(h);
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

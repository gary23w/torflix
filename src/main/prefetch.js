// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Metadata prefetch for the search results on screen, and pictures from inside the torrents.
// The top results are added two at a time with nothing selected; once a torrent's metadata is
// known, playing it skips the metadata lookup ("details ready"), and a small picture in it
// (a poster, a cover) is fetched for the results list. Prefetched torrents are paused after
// that so they hold no connections, kept for the session (a few at most), and dropped when a
// new search starts unless the user added them.

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { fileName, isImage, extensionOf } from '../shared/files.js';
import { pieceRange } from './pieces.js';

/** Most results prefetched per search. */
const MAX_RESULTS = 12;
const CONCURRENCY = 3;
const METADATA_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 20_000;
/** Pictures smaller than this are icons; larger ones are not worth the bandwidth. */
const IMAGE_MIN_BYTES = 2 * 1024;
const IMAGE_MAX_BYTES = 400 * 1024;
/** Prefetched torrents kept in the engine, most recent first. */
const KEEP = 12;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

export class Prefetch extends EventEmitter {
  constructor({ engine }) {
    super();
    this.engine = engine;
    this.generation = 0;
    this.queue = [];
    this.active = 0;
    /** @type {Map<string, {image:string|null, ready:boolean, error:string|null}>} by result key */
    this.results = new Map();
  }

  /** Replaces the list of results to prefetch (top of the screen first). */
  request(list) {
    this.generation += 1;
    const gen = this.generation;
    const seen = new Set();
    this.queue = list
      .slice(0, MAX_RESULTS)
      .filter((r) => r.link && r.key && !this.results.has(r.key) && !seen.has(r.key) && seen.add(r.key))
      .map((r) => ({ key: r.key, link: r.link, infoHash: r.infoHash ?? null, gen }));
    this.#pump();
    return this.snapshot(list.map((r) => r.key));
  }

  /** What is known for these result keys. */
  snapshot(keys) {
    const thumbnails = {};
    const prefetched = [];
    for (const key of keys) {
      const r = this.results.get(key);
      if (!r) continue;
      if (r.image) thumbnails[key] = r.image;
      if (r.ready) prefetched.push(key);
    }
    return { thumbnails, prefetched };
  }

  /** A new search: forget results and drop prefetched torrents nobody claimed. */
  reset() {
    this.generation += 1;
    this.queue = [];
    this.results.clear();
    const removals = [];
    for (const e of [...this.engine.entries.values()]) {
      if (e.origin === 'prefetch' && !e.claimed) removals.push(this.engine.remove(e, { destroyStore: true }).catch(() => {}));
    }
    return Promise.all(removals);
  }

  #pump() {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      this.#run(job).finally(() => {
        this.active -= 1;
        this.#pump();
      });
    }
  }

  async #run(job) {
    if (job.gen !== this.generation) return;
    let entry;
    try {
      entry = await this.engine.add(job.link, { infoHash: job.infoHash, origin: 'prefetch', timeoutMs: METADATA_TIMEOUT_MS });
    } catch (err) {
      this.results.set(job.key, { image: null, ready: false, error: err?.message ?? String(err) });
      return;
    }
    const record = { image: null, ready: true, error: null };
    this.results.set(job.key, record);
    this.emit('prefetched', { key: job.key });
    if (job.gen !== this.generation) return this.#release(entry);
    try {
      record.image = await this.#picture(entry);
      if (record.image) this.emit('thumbnail', { key: job.key, image: record.image });
    } catch {
      // no picture; the row keeps its placeholder
    }
    // Only a torrent the prefetch itself added is parked; the preload's or the user's keep running.
    if (entry.origin === 'prefetch') this.#park(entry);
    this.#trim();
  }

  /** The best picture in a torrent as a `data:` URL, or null. */
  async #picture(entry) {
    const files = this.engine.files(entry).filter((f) => isImage(f.path) && f.length >= IMAGE_MIN_BYTES && f.length <= IMAGE_MAX_BYTES);
    if (files.length === 0) return null;
    const score = (f) => (/poster|cover|folder|front|thumb|artwork|fanart/i.test(fileName(f.path)) ? 1 : 0);
    files.sort((a, b) => score(b) - score(a) || b.length - a.length);
    const target = files[0];
    const file = this.engine.file(entry, target.index);
    const torrent = entry.torrent;
    if (!torrent || torrent.destroyed) return null;
    if (torrent.paused && entry.pausedForPrefetch) {
      entry.pausedForPrefetch = false;
      torrent.resume();
    }
    const [a, b] = pieceRange(file, 0, file.length - 1);
    torrent.select(a, b, 1);
    try {
      const bytes = await withTimeout(file.arrayBuffer(), READ_TIMEOUT_MS);
      const mime = MIME[extensionOf(target.path)] ?? 'image/jpeg';
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } finally {
      try {
        if (!torrent.destroyed) torrent.deselect(a, b);
      } catch {
        // gone
      }
    }
  }

  /** Keeps the metadata but drops the connections. */
  #park(entry) {
    const t = entry.torrent;
    if (!t || t.destroyed || entry.claimed) return;
    entry.pausedForPrefetch = true;
    t.pause();
    for (const w of [...t.wires]) w.destroy();
  }

  #release(entry) {
    if (!entry.claimed && entry.origin === 'prefetch') this.engine.remove(entry, { destroyStore: true }).catch(() => {});
  }

  #trim() {
    const parked = [...this.engine.entries.values()].filter((e) => e.origin === 'prefetch' && !e.claimed).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const e of parked.slice(KEEP)) this.engine.remove(e, { destroyStore: true }).catch(() => {});
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
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

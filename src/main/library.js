// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The play queue and the playback library (watch progress, resume positions), kept in two JSON
// files in the app's data folder. The queue is the UI's: it saves whole queues and the
// background downloader reads them. The library is written by playback reports.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { JsonStore } from './store.js';

export const QUEUE_VERSION = 2;
/** A position this close to either end is not worth resuming. */
const RESUME_MARGIN_SECS = 10;
const MAX_LIBRARY_ITEMS = 2000;
const MAX_QUEUE_ITEMS = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{40}$/;

const isStr = (v, max = 2048) => typeof v === 'string' && v.length <= max;
const optStr = (v, max = 2048) => v === null || isStr(v, max);
const optNum = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

export function emptyQueue() {
  return { version: QUEUE_VERSION, items: [], current: null, order: 'inOrder' };
}

/** Checks a queue sent by the UI; returns the cleaned queue or throws. */
export function validateQueue(q) {
  if (q === null || typeof q !== 'object' || !Array.isArray(q.items)) throw new Error('Not a queue.');
  if (q.items.length > MAX_QUEUE_ITEMS) throw new Error('The queue is too long.');
  const ids = new Set();
  const items = q.items.map((it) => {
    if (it === null || typeof it !== 'object') throw new Error('Bad queue item.');
    if (!isStr(it.id, 64) || !ID_RE.test(it.id) || ids.has(it.id)) throw new Error('Bad queue item id.');
    ids.add(it.id);
    if (!isStr(it.source) || it.source.length === 0) throw new Error('Bad queue item source.');
    if (!(it.infoHash === null || (isStr(it.infoHash, 40) && HASH_RE.test(it.infoHash)))) throw new Error('Bad info hash.');
    if (!(it.fileIndex === null || (Number.isInteger(it.fileIndex) && it.fileIndex >= 0))) throw new Error('Bad file index.');
    if (!isStr(it.title, 1024)) throw new Error('Bad title.');
    if (!optStr(it.torrentName, 1024)) throw new Error('Bad torrent name.');
    if (!optNum(it.sizeBytes)) throw new Error('Bad size.');
    return {
      id: it.id,
      source: it.source,
      infoHash: it.infoHash ?? null,
      fileIndex: it.fileIndex ?? null,
      title: it.title,
      torrentName: it.torrentName ?? null,
      sizeBytes: it.sizeBytes ?? null,
      paused: Boolean(it.paused),
      skipped: Boolean(it.skipped),
      played: Boolean(it.played),
    };
  });
  const current = q.current === null || q.current === undefined ? null : ids.has(q.current) ? q.current : null;
  const order = q.order === 'fastest' ? 'fastest' : 'inOrder';
  return { version: QUEUE_VERSION, items, current, order };
}

export class Library extends EventEmitter {
  constructor(dataDir) {
    super();
    this.queueStore = new JsonStore(path.join(dataDir, 'queue.json'), emptyQueue);
    this.libraryStore = new JsonStore(path.join(dataDir, 'library.json'), () => ({ version: 1, items: {} }));
    let q;
    try {
      q = validateQueue(this.queueStore.loadSync());
    } catch (err) {
      this.queueStore.problems.push(`queue.json was invalid (${err.message}) and was reset.`);
      q = emptyQueue();
    }
    this.queue = q;
    const lib = this.libraryStore.loadSync();
    this.items = lib && typeof lib.items === 'object' && lib.items !== null ? lib.items : {};
    // Drop anything that does not look like an item.
    for (const [key, it] of Object.entries(this.items)) {
      if (!it || typeof it !== 'object' || !HASH_RE.test(it.infoHash ?? '') || !Number.isInteger(it.fileIndex)) delete this.items[key];
    }
    this.problems = [...this.queueStore.problems, ...this.libraryStore.problems];
    this.revision = 0;
  }

  // ----- queue -----

  loadQueue() {
    return structuredClone(this.queue);
  }

  saveQueue(q) {
    const clean = validateQueue(q);
    this.queue = clean;
    this.queueStore.save(clean);
    this.emit('queue-changed', clean);
    return clean;
  }

  // ----- library -----

  static key(infoHash, fileIndex) {
    return `${infoHash}:${fileIndex}`;
  }

  /** Every item, most recently used first. */
  list() {
    return Object.values(this.items).sort((a, b) => b.updatedAtSecs - a.updatedAtSecs);
  }

  get(infoHash, fileIndex) {
    return this.items[Library.key(infoHash, fileIndex)] ?? null;
  }

  /** Whether a file of this torrent was played (in this session or an earlier one). */
  watched(infoHash) {
    return Object.values(this.items).some((it) => it.infoHash === infoHash);
  }

  /** Records that a file was opened; keeps its progress. */
  opened({ infoHash, fileIndex, source, title, torrentName, sizeBytes }) {
    const key = Library.key(infoHash, fileIndex);
    const now = Math.floor(Date.now() / 1000);
    const prev = this.items[key];
    this.items[key] = {
      infoHash,
      fileIndex,
      source,
      title,
      torrentName,
      sizeBytes: sizeBytes ?? prev?.sizeBytes ?? null,
      positionSecs: prev?.positionSecs ?? 0,
      durationSecs: prev?.durationSecs ?? null,
      completed: prev?.completed ?? false,
      updatedAtSecs: now,
    };
    this.#trim();
    this.#save();
    return this.items[key];
  }

  /** A saved position worth offering to resume, or null. */
  resumePosition(infoHash, fileIndex) {
    const it = this.get(infoHash, fileIndex);
    if (!it || it.completed || it.positionSecs < RESUME_MARGIN_SECS) return null;
    if (it.durationSecs !== null && it.positionSecs > it.durationSecs - RESUME_MARGIN_SECS) return null;
    return it.positionSecs;
  }

  /** A playback checkpoint. Out-of-order writes cannot move the playhead backward. */
  progress(infoHash, fileIndex, { positionSecs, durationSecs, ended, revision }) {
    const key = Library.key(infoHash, fileIndex);
    const it = this.items[key];
    if (!it) return;
    if (revision !== undefined && it.revision !== undefined && revision < it.revision) return;
    it.revision = revision ?? (it.revision ?? 0) + 1;
    if (Number.isFinite(positionSecs) && positionSecs >= 0) it.positionSecs = positionSecs;
    if (Number.isFinite(durationSecs) && durationSecs > 0) it.durationSecs = durationSecs;
    if (ended) {
      it.completed = true;
      it.positionSecs = it.durationSecs ?? it.positionSecs;
    } else if (it.durationSecs && it.positionSecs < it.durationSecs - RESUME_MARGIN_SECS) {
      it.completed = false;
    }
    it.updatedAtSecs = Math.floor(Date.now() / 1000);
    this.#save();
  }

  remove(infoHash, fileIndex) {
    const key = Library.key(infoHash, fileIndex);
    if (key in this.items) {
      delete this.items[key];
      this.#save();
    }
  }

  clear() {
    this.items = {};
    this.#save();
  }

  #trim() {
    const keys = Object.keys(this.items);
    if (keys.length <= MAX_LIBRARY_ITEMS) return;
    const sorted = keys.sort((a, b) => this.items[a].updatedAtSecs - this.items[b].updatedAtSecs);
    for (const key of sorted.slice(0, keys.length - MAX_LIBRARY_ITEMS)) delete this.items[key];
  }

  #save() {
    this.revision += 1;
    this.libraryStore.save({ version: 1, items: this.items });
    this.emit('library-changed');
  }

  flush() {
    return Promise.all([this.queueStore.flush(), this.libraryStore.flush()]);
  }
}

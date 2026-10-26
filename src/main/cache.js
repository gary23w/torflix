// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The download cache: how much space it uses, what can be cleared safely (finished, unqueued
// downloads nothing has open), and the automatic limits (size cap, expiry of old downloads).

import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES_COUNTED = 50_000;
const ENFORCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Bytes a file takes on disk. A partial download is sparse: a film watched for ten minutes is
 * its full length long but holds only what was fetched, and counting its length would have the
 * size limit delete it (and its resume point's data) at the next start.
 */
export function diskBytes(st) {
  return Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;
}

async function sizeOf(dir, counter) {
  let total = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        counter.files += 1;
        if (counter.files > MAX_FILES_COUNTED) {
          counter.complete = false;
          return { total, newest };
        }
        try {
          const st = await fsp.stat(p);
          total += diskBytes(st);
          newest = Math.max(newest, st.mtimeMs);
        } catch {
          // skipped
        }
      }
    }
  }
  return { total, newest };
}

export class Cache {
  constructor({ downloadDir, engine, library, settings }) {
    this.downloadDir = downloadDir;
    this.engine = engine;
    this.library = library;
    this.settings = settings;
    this.timer = null;
  }

  start() {
    this.enforce().catch(() => {});
    this.timer = setInterval(() => this.enforce().catch(() => {}), ENFORCE_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Names (top-level folders or files in the download folder) that must not be touched. */
  #protectedNames() {
    const names = new Set();
    for (const e of this.engine.entries.values()) {
      if (e.torrent?.name) names.add(e.torrent.name);
    }
    for (const item of this.library.queue.items) {
      if (item.torrentName) names.add(item.torrentName);
      names.add(item.title);
    }
    return names;
  }

  /** Top-level entries of the download folder with their size and age. */
  async #entries() {
    let list;
    try {
      list = await fsp.readdir(this.downloadDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    const counter = { files: 0, complete: true };
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(this.downloadDir, e.name);
      let bytes = 0;
      let newest = 0;
      if (e.isDirectory()) {
        const r = await sizeOf(p, counter);
        bytes = r.total;
        newest = r.newest;
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(p);
          bytes = diskBytes(st);
          newest = st.mtimeMs;
          counter.files += 1;
        } catch {
          continue;
        }
      } else continue;
      out.push({ name: e.name, path: p, bytes, newest });
    }
    out.complete = counter.complete;
    out.files = counter.files;
    return out;
  }

  async usage() {
    const entries = await this.#entries();
    const protectedNames = this.#protectedNames();
    const limitGb = this.settings.settings.storage.cacheLimitGb;
    const reclaimable = entries.filter((e) => !protectedNames.has(e.name));
    return {
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
      files: entries.files ?? 0,
      complete: entries.complete ?? true,
      limitBytes: limitGb === null ? null : limitGb * 1_000_000_000,
      reclaimableBytes: reclaimable.reduce((n, e) => n + e.bytes, 0),
      reclaimableDownloads: reclaimable.length,
    };
  }

  /** Removes finished, unqueued downloads nothing has open. */
  async clear() {
    const entries = await this.#entries();
    const protectedNames = this.#protectedNames();
    let removedBytes = 0;
    let removed = 0;
    for (const e of entries) {
      if (protectedNames.has(e.name)) continue;
      try {
        await fsp.rm(e.path, { recursive: true, force: true });
        removedBytes += e.bytes;
        removed += 1;
      } catch {
        // locked or gone
      }
    }
    return { removedBytes, removedDownloads: removed };
  }

  /** Applies the size limit and the expiry to unprotected downloads. */
  async enforce() {
    const { cacheLimitGb, cleanupAfterDays } = this.settings.settings.storage;
    if (cacheLimitGb === null && cleanupAfterDays === null) return;
    const entries = await this.#entries();
    const protectedNames = this.#protectedNames();
    const candidates = entries.filter((e) => !protectedNames.has(e.name)).sort((a, b) => a.newest - b.newest);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    const now = Date.now();
    for (const e of candidates) {
      const expired = cleanupAfterDays !== null && now - e.newest > cleanupAfterDays * 86_400_000;
      const over = cacheLimitGb !== null && total > cacheLimitGb * 1_000_000_000;
      if (!expired && !over) continue;
      try {
        await fsp.rm(e.path, { recursive: true, force: true });
        total -= e.bytes;
      } catch {
        // skipped
      }
    }
  }
}

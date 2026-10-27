// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The torrent engine: a WebTorrent client behind a small facade. Every torrent starts with
// nothing selected; playback, the queue, and preloads select only the files they need. Limits
// (download, upload, peers) follow the settings as they change.

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileKind, sortFiles } from '../shared/files.js';

/** Public trackers added to magnet links so sparse links still find peers. */
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
];
/**
 * How long a magnet link may take to find its metadata. Only the metadata: checking data
 * already on disk afterwards is local work and never times out.
 */
const METADATA_TIMEOUT_MS = 90_000;
/** How many torrents are kept in the Open page's "opened this session" list. */
const MAX_ENTRIES = 200;
const MAGNET_RE = /^magnet:\?/i;
const HTTP_RE = /^https?:\/\//i;
/** Torrents added for the app's own purposes, not the user's: never uploaded, dropped if unused. */
const BACKGROUND_ORIGINS = new Set(['preload', 'prefetch']);
/** Peers a torrent uploads to at once (WebTorrent's default). */
const UPLOAD_SLOTS = 10;

let nextId = 1;

export class EngineError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** One added torrent. */
class Entry {
  constructor({ source, origin }) {
    this.id = nextId++;
    this.source = source;
    this.origin = origin;
    this.infoHash = null;
    this.torrent = null;
    this.ready = false;
    this.error = null;
    /** Resolves with the entry (or the duplicate it turned out to be) once the metadata is known. */
    this.readyPromise = null;
    /** Whether the metadata is known (from a peer, a .torrent file, or saved resume data). */
    this.metadataKnown = false;
    /** `deadline(ms)` restarts the metadata timeout; `deadline(null)` clears it. */
    this.deadline = () => {};
    this.timer = null;
    this.addedAt = Date.now();
    this.lastUsedAt = Date.now();
    /** File indexes the background downloader selected. */
    this.bgSelected = new Set();
    /** Whether the user asked for it (Open, Play, Queue); preloads and prefetches are unclaimed until then. */
    this.claimed = !BACKGROUND_ORIGINS.has(origin);
    this.completedAt = null;
    this.pausedForSeeding = false;
    this.pausedForPrefetch = false;
  }

  get name() {
    return this.torrent?.name ?? this.torrent?.infoHash ?? this.infoHash ?? 'torrent';
  }

  /**
   * The user asked for it (to play, open or queue): it is theirs now. A preload or prefetch was
   * added never to upload; from here it uploads like any torrent watched (BitTorrent peers send
   * to those who send back).
   */
  claim() {
    this.claimed = true;
    if (BACKGROUND_ORIGINS.has(this.origin)) this.origin = 'user';
    const t = this.torrent;
    if (t && !t.destroyed && t._rechokeNumSlots === 0) t._rechokeNumSlots = UPLOAD_SLOTS;
  }

  /**
   * Reconnects a torrent that was paused (quieted after a watch, or a parked prefetch). A
   * paused torrent drops the peers it hears of, so it also asks its trackers and the DHT for
   * peers again at once, rather than at the next scheduled announce (up to 15 minutes away).
   */
  wake() {
    const t = this.torrent;
    if (!t || t.destroyed || !t.paused) return;
    this.pausedForSeeding = false;
    this.pausedForPrefetch = false;
    t.resume();
    try {
      t.discovery?.tracker?.update?.();
    } catch {
      // no trackers
    }
    try {
      if (typeof t.discovery?._dhtAnnounce === 'function') t.discovery._dhtAnnounce();
    } catch {
      // no DHT
    }
  }
}

export class Engine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.downloadDir
   * @param {import('./settings.js').SettingsStore} opts.settings
   */
  constructor({ downloadDir, settings, resume = null }) {
    super();
    this.downloadDir = downloadDir;
    this.settings = settings;
    /** @type {import('./resume.js').ResumeStore|null} saved metadata and piece maps */
    this.resume = resume;
    /** Adds in progress, by info hash, so two adds of one torrent share one. */
    this.adding = new Map();
    this.client = null;
    this.WebTorrent = null;
    this.parseTorrent = null;
    this.toMagnetURI = null;
    /** @type {Map<number, Entry>} */
    this.entries = new Map();
    this.debug = Boolean(process.env.TORRENTPLAYER_DEBUG) || process.argv.includes('--smoke') || process.argv.includes('--dev');
  }

  async start() {
    const [{ default: WebTorrent }, pt, { default: Peer }] = await Promise.all([import('webtorrent'), import('parse-torrent'), import('webtorrent/lib/peer.js')]);
    guardHandshake(Peer);
    this.WebTorrent = WebTorrent;
    this.parseTorrent = pt.default;
    this.toMagnetURI = pt.toMagnetURI;
    this.settings.on('change', (next) => this.applySettings(next));
    return this.#createClient();
  }

  #createClient() {
    const s = this.settings.settings;
    const incoming = s.network.incomingPeers;
    const client = new this.WebTorrent({
      maxConns: s.bandwidth.peerLimit,
      downloadLimit: s.bandwidth.downloadLimitKib > 0 ? s.bandwidth.downloadLimitKib * 1024 : -1,
      uploadLimit: s.bandwidth.uploadLimitKib > 0 ? s.bandwidth.uploadLimitKib * 1024 : -1,
      torrentPort: incoming.enabled && incoming.port > 0 ? incoming.port : 0,
      natUpnp: incoming.enabled && incoming.upnp,
      natPmp: incoming.enabled && incoming.upnp,
      dht: true,
      lsd: true,
      utPex: true,
      tracker: { wrtc: false },
      userAgent: 'Torflix/0.3.0',
    });
    this.client = client;
    client.on('error', (err) => this.#onClientError(client, err));
    return new Promise((resolve) => {
      if (client.listening) resolve();
      else client.once('listening', resolve);
      // Do not hold start-up hostage to a slow port bind.
      setTimeout(resolve, 3000);
    });
  }

  /**
   * WebTorrent reports failures of the whole client (a DHT or listening socket it could not
   * open, for example) as `error` events, and destroys itself after some of them. They are
   * passed on as `client-error`: an `error` event nobody listens for would crash the main
   * process. A destroyed client is replaced, so the app keeps working.
   */
  #onClientError(client, err) {
    const message = err?.message ?? String(err);
    console.error('[engine] client error:', message);
    if (client !== this.client || this.stopping) return;
    const restarting = client.destroyed === true;
    this.emit('client-error', { message, restarting });
    if (restarting) this.#restart(message).catch((e) => console.error('[engine] restart failed:', e?.message ?? e));
  }

  async #restart(reason) {
    if (this.restarting) return;
    this.restarting = true;
    try {
      const lost = [...this.entries.values()];
      this.entries.clear();
      for (const e of lost) {
        e.deadline(null);
        this.emit('removed', e);
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (this.stopping) return;
      await this.#createClient();
      console.error(`[engine] restarted after: ${reason}`);
      this.emit('restarted', { reason, lost: lost.filter((e) => e.claimed).length });
    } finally {
      this.restarting = false;
    }
  }

  applySettings(s) {
    if (!this.client) return;
    this.client.throttleDownload(s.bandwidth.downloadLimitKib > 0 ? s.bandwidth.downloadLimitKib * 1024 : -1);
    this.client.throttleUpload(s.bandwidth.uploadLimitKib > 0 ? s.bandwidth.uploadLimitKib * 1024 : -1);
    this.client.maxConns = s.bandwidth.peerLimit;
  }

  /** The info hash a magnet link or `.torrent` file names, lowercase hex, or null. */
  async infoHashOf(source, bytes) {
    try {
      const parsed = await this.parseTorrent(bytes ? Buffer.from(bytes) : source);
      return parsed?.infoHash?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  byInfoHash(infoHash) {
    if (!infoHash) return null;
    for (const e of this.entries.values()) if (e.infoHash === infoHash) return e;
    return null;
  }

  bySource(source) {
    for (const e of this.entries.values()) if (e.source === source) return e;
    return null;
  }

  get(id) {
    return this.entries.get(id) ?? null;
  }

  /**
   * Adds a torrent (magnet link, http(s) link to a `.torrent` file, or `.torrent` bytes) and
   * resolves with its entry once the metadata is known. A torrent already added is reused.
   */
  async add(source, { bytes = null, origin = 'user', infoHash = null, timeoutMs = METADATA_TIMEOUT_MS } = {}) {
    if (!this.client) throw new EngineError('engine', 'The torrent engine is not running.');
    if (this.client.destroyed || this.restarting) throw new EngineError('engine', 'The torrent engine is restarting after a network error; try again in a moment.');
    if (!bytes && !(MAGNET_RE.test(source) || HTTP_RE.test(source))) {
      throw new EngineError('invalidLink', 'Enter a magnet link or an http(s) link to a .torrent file.');
    }
    // A torrent already open: no network, no disk.
    const hint = infoHash?.toLowerCase() ?? null;
    const open = this.#reuse(this.byInfoHash(hint), origin, timeoutMs);
    if (open) return open;
    if (hint && this.adding.has(hint)) return this.#afterAdding(hint, origin, timeoutMs);
    const saved = hint ? (this.resume?.load(hint) ?? null) : null;
    if (!bytes && HTTP_RE.test(source)) {
      const known = this.bySource(source);
      if (known) {
        known.lastUsedAt = Date.now();
        if (!BACKGROUND_ORIGINS.has(origin)) known.claim();
        if (known.ready) return known;
      }
      if (saved?.torrentFile) {
        // Its metadata was saved: the link's own lookup is not needed.
        bytes = saved.torrentFile;
      } else {
        // A link to a .torrent file, or (the search service's download links) a redirect to a
        // magnet link. Resolved here: the engine's own fetch cannot follow a magnet redirect.
        const resolved = await resolveRemote(source);
        if (resolved.magnet) source = resolved.magnet;
        else bytes = resolved.bytes;
      }
    }
    const hash = hint ?? (await this.infoHashOf(source, bytes));
    const existing = this.#reuse(this.byInfoHash(hash) ?? (bytes ? null : this.bySource(source)), origin, timeoutMs);
    if (existing) return existing;
    if (hash && this.adding.has(hash)) return this.#afterAdding(hash, origin, timeoutMs);

    const entry = new Entry({ source: bytes ? `magnet:?xt=urn:btih:${hash}` : source, origin });
    entry.infoHash = hash;
    const pending = (async () => {
      const resume = await this.#resumeFor(hash, saved ?? (hash ? this.resume?.load(hash) : null));
      const torrentId = resume.torrentFile ?? (bytes ? Buffer.from(bytes) : source);
      return this.#create(entry, torrentId, timeoutMs, resume);
    })();
    if (hash) {
      this.adding.set(hash, pending);
      pending.catch(() => {}).finally(() => this.adding.get(hash) === pending && this.adding.delete(hash));
    }
    return pending;
  }

  /** What a second caller of a torrent being added gets: the same torrent, claimed if theirs. */
  async #afterAdding(hash, origin, timeoutMs) {
    const entry = await this.adding.get(hash);
    return this.#reuse(entry, origin, timeoutMs) ?? entry;
  }

  /** An entry already added, claimed for its new caller; null if there is none. */
  #reuse(existing, origin, timeoutMs) {
    if (!existing) return null;
    existing.lastUsedAt = Date.now();
    if (!BACKGROUND_ORIGINS.has(origin)) existing.claim();
    // A parked prefetch is wanted again (to play, queue, or preload): reconnect it.
    if (origin !== 'prefetch' && existing.pausedForPrefetch) existing.wake();
    if (existing.ready) return existing;
    if (existing.error) return Promise.reject(existing.error);
    // A second caller gets its own full wait; the torrent is kept as long as someone waits.
    existing.deadline(timeoutMs);
    return existing.readyPromise;
  }

  /**
   * How to add a torrent so data already on disk is not hashed again: its saved metadata and
   * piece map, the map used only while its files are still there (a cleared cache makes it
   * stale; WebTorrent also re-checks a sample piece of each file and rehashes a file that fails).
   */
  async #resumeFor(hash, saved) {
    const none = { torrentFile: null, bitfield: null };
    if (!saved?.torrentFile) return none;
    let files;
    try {
      const parsed = await this.parseTorrent(saved.torrentFile);
      if (parsed?.infoHash?.toLowerCase() !== hash) return none;
      files = parsed.files ?? [];
    } catch {
      return none;
    }
    const onDisk = files.some((f) => fs.existsSync(path.join(this.downloadDir, f.path)));
    return { torrentFile: saved.torrentFile, bitfield: onDisk ? saved.bitfield : null };
  }

  #create(entry, torrentId, timeoutMs, resume = { torrentFile: null, bitfield: null }) {
    const opts = {
      path: this.downloadDir,
      deselect: true,
      strategy: 'sequential',
      maxWebConns: 4,
      announce: EXTRA_TRACKERS,
      storeCacheSlots: 20,
      destroyStoreOnDestroy: false,
      uploads: BACKGROUND_ORIGINS.has(entry.origin) ? false : UPLOAD_SLOTS,
    };
    if (resume.bitfield) opts.bitfield = resume.bitfield;
    const torrent = this.client.add(torrentId, opts);
    entry.torrent = torrent;
    this.resume?.track(torrent);
    // WebTorrent emits `metadata` right before it checks the data on disk, synchronously.
    torrent.once('metadata', () => {
      entry.metadataKnown = true;
      clearTimeout(entry.timer);
      entry.timer = null;
      // Nothing of it on disk and no piece map: there is nothing to check. An empty startup
      // piece map makes WebTorrent skip hashing (else it reads every piece and fails each).
      if (!opts.bitfield && !this.#anyFileOnDisk(torrent)) torrent._hasStartupBitfield = true;
    });
    entry.addedAt = Date.now();
    this.entries.set(entry.id, entry);
    this.#trimEntries();
    this.emit('added', entry);
    const log = (what, extra = '') => this.debug && console.log(`[engine] ${entry.infoHash?.slice(0, 8) ?? entry.id} ${what} +${Date.now() - entry.addedAt}ms ${extra}`);

    let settled = false;
    entry.readyPromise = new Promise((resolve, reject) => {
      const finish = (err, result = entry) => {
        if (settled) return;
        settled = true;
        entry.deadline(null);
        if (err) {
          entry.error = err;
          reject(err);
        } else resolve(result);
      };
      entry.deadline = (ms) => {
        clearTimeout(entry.timer);
        entry.timer = null;
        if (ms === null || settled || entry.metadataKnown) return;
        entry.timer = setTimeout(() => {
          if (entry.ready || settled) return;
          log('metadata timed out', `(${torrent.numPeers} peers, ${torrent._peersLength ?? 0} seen)`);
          finish(new EngineError('timeout', 'No peers answered with the torrent’s details. Check the link, or try again later.'));
          // Without metadata nothing was written: never delete what may be on disk.
          this.remove(entry, { destroyStore: false }).catch(() => {});
        }, ms);
      };
      torrent.once('ready', () => {
        // WebTorrent destroys a duplicate and hands back the first one; keep the survivor.
        const dup = [...this.entries.values()].find((e) => e !== entry && e.infoHash === torrent.infoHash && e.ready);
        if (dup) {
          this.entries.delete(entry.id);
          dup.lastUsedAt = Date.now();
          if (!BACKGROUND_ORIGINS.has(entry.origin)) dup.claim();
          return finish(null, dup);
        }
        entry.infoHash = torrent.infoHash;
        entry.ready = true;
        log('ready', `${torrent.name} (${torrent.files.length} files)`);
        this.emit('ready', entry);
        finish();
      });
      torrent.once('error', (err) => {
        this.entries.delete(entry.id);
        log('error', err?.message);
        // A `.torrent` link whose hash was unknown may name a torrent already open.
        const dup = /duplicate torrent ([0-9a-f]{40})/i.exec(err?.message ?? '');
        const existing = dup ? this.byInfoHash(dup[1].toLowerCase()) : null;
        if (existing) {
          existing.lastUsedAt = Date.now();
          if (!BACKGROUND_ORIGINS.has(entry.origin)) existing.claim();
          if (existing.ready) return finish(null, existing);
          existing.readyPromise.then((e) => finish(null, e), (e) => finish(e));
          return;
        }
        finish(new EngineError('torrent', friendly(err)));
      });
      torrent.once('close', () => {
        if (settled) return;
        this.entries.delete(entry.id);
        log('closed before ready');
        finish(new EngineError('torrent', 'The torrent was removed before it was ready.'));
      });
      entry.deadline(timeoutMs);
    });
    entry.readyPromise.catch(() => {});
    if (this.debug) {
      torrent.once('infoHash', () => log('infoHash'));
      torrent.once('metadata', () => log('metadata'));
      torrent.on('warning', (w) => log('warning', w?.message));
      torrent.on('wire', (_w, addr) => log('peer', addr ?? ''));
      torrent.on('noPeers', (kind) => log('noPeers', kind));
    }
    torrent.on('error', (err) => {
      this.emit('torrent-error', entry, err);
    });
    torrent.on('warning', () => {});
    torrent.on('done', () => {
      entry.completedAt = Date.now();
    });
    return entry.readyPromise;
  }

  #trimEntries() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const idle = [...this.entries.values()]
      .filter((e) => e.origin === 'preload' || (!e.claimed && e.bgSelected.size === 0))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const e of idle.slice(0, this.entries.size - MAX_ENTRIES)) this.remove(e, { destroyStore: !e.claimed }).catch(() => {});
  }

  /** Files of a torrent as `FileSummary`, videos first. */
  files(entry) {
    if (!entry.ready) return [];
    return sortFiles(
      entry.torrent.files.map((f, index) => ({ index, path: f.path.replace(/\\/g, '/'), length: f.length, kind: fileKind(f.path) })),
    );
  }

  file(entry, index) {
    const f = entry.torrent?.files?.[index];
    if (!f) throw new EngineError('noSuchFile', 'That file is not in the torrent.');
    return f;
  }

  /** A magnet link that adds the torrent again, with up to 20 of its trackers. */
  magnetOf(entry) {
    const t = entry.torrent;
    try {
      return this.toMagnetURI({ infoHash: t.infoHash, name: t.name, announce: (t.announce ?? []).slice(0, 20) });
    } catch {
      return `magnet:?xt=urn:btih:${t.infoHash}`;
    }
  }

  summary(entry) {
    const t = entry.torrent;
    return {
      id: entry.id,
      name: t.name ?? entry.infoHash,
      infoHash: entry.infoHash,
      totalLength: t.length ?? 0,
      files: this.files(entry),
      magnet: this.magnetOf(entry),
    };
  }

  details(entry) {
    const t = entry.torrent;
    const announce = t.announce ?? [];
    const created = t.created instanceof Date ? t.created.getTime() : null;
    return {
      infoHash: entry.infoHash,
      files: this.files(entry).sort((a, b) => a.index - b.index),
      pieceLength: t.pieceLength,
      totalLength: t.length,
      udpTrackers: announce.filter((u) => u.startsWith('udp:')).length,
      httpTrackers: announce.filter((u) => /^https?:/.test(u)).length,
      webSeeds: (t.urlList ?? []).length,
      private: typeof t.private === 'boolean' ? t.private : null,
      comment: typeof t.comment === 'string' ? t.comment.slice(0, 500) : null,
      createdBy: typeof t.createdBy === 'string' ? t.createdBy.slice(0, 200) : null,
      createdMs: created,
    };
  }

  /** Every entry the user asked for, most recent first (the Open page's list, Files). */
  list() {
    return [...this.entries.values()]
      .filter((e) => e.ready && e.claimed)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((e) => this.summary(e));
  }

  /** Whether any file of a torrent already exists in the download folder. */
  #anyFileOnDisk(torrent) {
    const root = torrent.path ?? this.downloadDir;
    return (torrent.files ?? []).some((f) => {
      try {
        return fs.existsSync(path.join(root, f.path));
      } catch {
        return false;
      }
    });
  }

  async remove(entry, { destroyStore = false } = {}) {
    this.entries.delete(entry.id);
    entry.deadline(null);
    const t = entry.torrent;
    if (!t || t.destroyed) return;
    if (destroyStore) await this.resume?.forget(t.infoHash);
    else await this.resume?.saveBitfield(t).catch(() => {});
    await new Promise((resolve) => this.client.remove(t, { destroyStore }, () => resolve()));
    this.emit('removed', entry);
  }

  /** Total transfer rates of every torrent. */
  totals() {
    if (!this.client) return { downloadBps: 0, uploadBps: 0 };
    return { downloadBps: this.client.downloadSpeed, uploadBps: this.client.uploadSpeed };
  }

  /** Stops every torrent (quit). Waits for the client, since exiting while it lives crashes. */
  async destroy() {
    this.stopping = true;
    if (!this.client || this.client.destroyed) return;
    const t0 = Date.now();
    const count = this.client.torrents.length;
    // The piece maps first, so next time nothing on disk is hashed again.
    await this.resume?.flush(this.client.torrents);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      this.client.destroy(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.debug) console.log(`[engine] destroyed ${count} torrents in ${Date.now() - t0} ms`);
    this.client = null;
  }
}

const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;

/**
 * Fetches an http(s) torrent link: `{ magnet }` when it redirects to a magnet link (as the
 * search service's download links do), else `{ bytes }` of the `.torrent` file.
 */
export async function resolveRemote(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/x-bittorrent, */*', 'User-Agent': 'Torflix/0.3.0' },
      });
    } catch (err) {
      throw new EngineError('fetch', 'The .torrent file could not be fetched from that link.');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new EngineError('fetch', 'The link redirected nowhere.');
      if (MAGNET_RE.test(location)) return { magnet: location };
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new EngineError('fetch', 'The link redirected to an invalid address.');
      }
      if (!HTTP_RE.test(next)) throw new EngineError('fetch', 'The link redirected to an unsupported address.');
      current = next;
      continue;
    }
    if (!res.ok) throw new EngineError('fetch', `The link answered ${res.status}.`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_TORRENT_BYTES) throw new EngineError('tooLarge', 'That .torrent file is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_TORRENT_BYTES) throw new EngineError('tooLarge', 'That .torrent file is too large.');
    const text = buf.subarray(0, 64).toString('latin1');
    if (MAGNET_RE.test(text.trim())) return { magnet: buf.toString('utf8').trim() };
    if (!text.startsWith('d')) throw new EngineError('invalidLink', 'That link is not a .torrent file.');
    return { bytes: buf };
  }
  throw new EngineError('fetch', 'The link redirected too many times.');
}

/**
 * WebTorrent sends its handshake when an encrypted connection's own finishes, even when the peer
 * was destroyed in between (downloads.js drops a torrent's peers once nothing watches it), and
 * then reads the swarm the peer no longer has: an uncaught TypeError that ends the process. Seen
 * when a stream stopped during an incoming connection. A destroyed peer has nothing to send.
 */
export function guardHandshake(Peer) {
  const handshake = Peer.prototype.handshake;
  if (typeof handshake !== 'function' || handshake.guarded) return;
  Peer.prototype.handshake = function guardedHandshake() {
    if (!this.swarm || !this.wire) return;
    return handshake.call(this);
  };
  Peer.prototype.handshake.guarded = true;
}

function friendly(err) {
  const m = err?.message ?? String(err);
  if (/Invalid torrent identifier/i.test(m)) return 'That is not a torrent: paste a magnet link or a link to a .torrent file.';
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(m)) return 'The .torrent file could not be fetched from that link.';
  if (/ENOSPC/i.test(m)) return 'The download folder is out of space.';
  if (/EACCES|EPERM/i.test(m)) return 'The download folder cannot be written to.';
  return m;
}

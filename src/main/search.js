// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Search over public torrent indexes, asked directly from this device (indexers.js): every
// source at once, each one's results merged and ranked here as it answers, and reported to the
// window at most every 150 ms. No service sits in between, so no one else's outage stops search.
// Finished searches are kept for 10 minutes, and requests to one host are spaced, so the indexes
// are asked gently.

import { EventEmitter } from 'node:events';
import { kindOfCategoryIds, parseQuality, rank, reason, watchScore } from '../shared/quality.js';
import { userAgent as torflixUserAgent } from '../shared/meta/util.js';
import { SOURCES } from './indexers.js';

const PROGRESS_INTERVAL_MS = 150;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_LENGTH = 200;
/** Least time between the starts of two requests to one host. */
const HOST_GAP_MS = 350;

/** A search that failed as a whole: its message is already what the window shows. */
export class SearchError extends Error {}

let nextSearchId = 1;

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const strOrNull = (v, max = 2048) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const HASH_RE = /^[0-9a-fA-F]{40}$/;

function categoryIds(raw) {
  const ids = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
    if (Number.isFinite(n)) ids.push(n);
  }
  return ids;
}

function httpsOnly(url) {
  const u = strOrNull(url);
  return u && /^https:\/\//i.test(u) ? u : null;
}

function httpOrHttps(url) {
  const u = strOrNull(url);
  return u && /^https?:\/\//i.test(u) ? u : null;
}

/** A raw result from the service, checked field by field, or null when it cannot be used. */
function candidate(raw, indexerName) {
  if (!raw || typeof raw !== 'object') return null;
  const title = strOrNull(raw.title, 1024)?.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const ids = categoryIds(raw.categories);
  const infoHash = strOrNull(raw.infohash, 40);
  const hash = infoHash && HASH_RE.test(infoHash) ? infoHash.toLowerCase() : null;
  const magnet = strOrNull(raw.magnet, 8192);
  const magnetOk = magnet && /^magnet:\?/i.test(magnet) ? magnet : hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` : null;
  const download = httpsOnly(raw.download);
  if (!magnetOk && !download) return null;
  const suspicious = raw.suspicious === true;
  const seeders = suspicious ? null : numOrNull(raw.seeders);
  return {
    title,
    sizeBytes: numOrNull(raw.size),
    seeders,
    peers: numOrNull(raw.peers),
    key: hash ?? `download:${download}`,
    link: magnetOk ?? download,
    magnet: magnetOk,
    infoHash: hash,
    download,
    detailsUrl: httpOrHttps(raw.details),
    indexers: [strOrNull(raw.tracker, 100) ?? indexerName ?? 'unknown'],
    category: strOrNull(raw.category, 100),
    categoryIds: ids,
    adult: ids.some((id) => id >= 6000 && id <= 6999),
    published: strOrNull(raw.published, 64),
    license: null,
    health: ['good', 'low', 'dead', 'unknown'].includes(raw.health) ? raw.health : null,
    suspicious,
  };
}

class Search extends EventEmitter {
  constructor({ id, query, categories, hideAdult, limit, audioConverts = false }) {
    super();
    this.id = id;
    this.query = query;
    this.categories = categories;
    this.hideAdult = hideAdult;
    this.limit = limit;
    this.audioConverts = audioConverts;
    this.controller = new AbortController();
    /** @type {Map<string, any>} merged by key */
    this.found = new Map();
    this.indexers = [];
    this.completed = 0;
    this.total = 0;
    this.done = false;
    this.cached = false;
    this.error = null;
    this.excludedAdult = 0;
    this.lastEmit = 0;
    this.timer = null;
  }

  /** Merges one indexer's results. */
  absorb(rawResults, indexerName) {
    for (const raw of Array.isArray(rawResults) ? rawResults : []) {
      const c = candidate(raw, indexerName);
      if (!c) continue;
      if (c.adult && this.hideAdult) {
        this.excludedAdult += 1;
        continue;
      }
      const prev = this.found.get(c.key);
      if (!prev) {
        this.found.set(c.key, c);
        continue;
      }
      for (const name of c.indexers) if (!prev.indexers.includes(name)) prev.indexers.push(name);
      if ((c.seeders ?? -1) > (prev.seeders ?? -1)) {
        prev.seeders = c.seeders;
        prev.peers = c.peers;
      }
      prev.sizeBytes ??= c.sizeBytes;
      prev.magnet ??= c.magnet;
      prev.download ??= c.download;
      prev.detailsUrl ??= c.detailsUrl;
      prev.published ??= c.published;
      prev.health ??= c.health;
      if (prev.link.startsWith('http') && c.magnet) prev.link = c.magnet;
    }
  }

  /** The response as the UI sees it: ranked, with reasons and a best pick. */
  response() {
    const results = [...this.found.values()].map((c) => {
      const quality = parseQuality(c.title, c.category, c.sizeBytes, kindOfCategoryIds(c.categoryIds), { audioConverts: this.audioConverts });
      const r = {
        title: c.title,
        sizeBytes: c.sizeBytes,
        seeders: c.seeders,
        peers: c.peers,
        key: c.key,
        link: c.link,
        magnet: c.magnet,
        infoHash: c.infoHash,
        download: c.download,
        detailsUrl: c.detailsUrl,
        indexers: [...c.indexers],
        category: c.category,
        published: c.published,
        license: c.license,
        health: c.health,
        suspicious: c.suspicious,
        quality,
        reason: reason(c.seeders, quality),
        bestPick: false,
        watchScore: watchScore(c.seeders, c.peers, quality),
      };
      return r;
    });
    const ranked = rank(results, this.query);
    for (const r of ranked) delete r.watchScore;
    return { results: ranked, indexers: [...this.indexers], excludedAdult: this.excludedAdult };
  }

  progress() {
    return {
      response: this.response(),
      completed: this.completed,
      total: Math.max(this.total, this.completed),
      done: this.done,
      cached: this.cached,
      error: this.error,
    };
  }

  /** Emits progress, at most every 150 ms (and always when done). */
  notify(force = false) {
    const now = Date.now();
    const wait = PROGRESS_INTERVAL_MS - (now - this.lastEmit);
    if (force || wait <= 0) {
      clearTimeout(this.timer);
      this.timer = null;
      this.lastEmit = now;
      this.emit('progress', this.progress());
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.notify(true), wait);
    }
  }

  finish(error = null) {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.notify(true);
    this.emit('done');
  }

  cancel() {
    this.controller.abort();
    this.finish(this.found.size > 0 ? null : 'cancelled');
  }
}

export class SearchService {
  /**
   * @param {object} opts
   * @param {string} [opts.version] Torflix's version, for its User-Agent
   * @param {string|null} [opts.platform] 'desktop' or 'android-tv', likewise
   * @param {Array} [opts.sources] the indexes to ask (indexers.js)
   */
  constructor({ settings, version = '0', platform = null, sources = SOURCES, fetchImpl = globalThis.fetch } = {}) {
    this.settings = settings;
    this.userAgent = torflixUserAgent(version, platform);
    this.sources = sources;
    this.fetchImpl = fetchImpl;
    this.current = null;
    /** @type {Map<string, {at:number, search:Search}>} */
    this.cache = new Map();
    /** When a request to each host last started, and the turn the next one waits for. */
    this.lastRequest = new Map();
    this.turns = new Map();
    /** The app's own searches in flight, so two asking the same share one search. */
    this.quickPending = new Map();
    this.sink = null;
  }

  /** Where progress goes: `(searchId, progress) => void`. */
  setSink(fn) {
    this.sink = fn;
  }

  cancel() {
    if (this.current && !this.current.done) this.current.cancel();
    this.current = null;
  }

  /**
   * Starts a search and returns its id at once; progress follows as `search-progress` events.
   * A running search is cancelled first: one at a time.
   */
  start(query, { categories = [] } = {}) {
    const text = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
    if (!text) throw new Error('Type something to search for.');
    const cats = [...new Set(categories.filter((c) => Number.isInteger(c) && c > 0 && c < 200_000))].sort();
    this.cancel();
    const s = this.settings?.settings.search ?? { hideAdult: true, resultsPerSearch: 100 };
    const cacheKey = JSON.stringify([text.toLowerCase(), cats, s.hideAdult, Boolean(this.audioConverts)]);
    this.#evict();
    const hit = this.cache.get(cacheKey);
    const id = nextSearchId++;
    if (hit) {
      const search = hit.search;
      queueMicrotask(() => this.sink?.(id, { ...search.progress(), cached: true }));
      return id;
    }
    const search = new Search({ id, query: text, categories: cats, hideAdult: s.hideAdult, limit: s.resultsPerSearch, audioConverts: this.audioConverts });
    search.on('progress', (p) => this.sink?.(id, p));
    search.on('done', () => {
      if (search.error === null || search.found.size > 0) this.cache.set(cacheKey, { at: Date.now(), search });
    });
    this.current = search;
    this.#run(search).catch((err) => {
      if (!search.done) search.finish(describeError(err));
    });
    return id;
  }

  /**
   * A search for the app's own use (the Browse page, title pages), not the user's: the same
   * sources, never shown as progress, cached like any search. The user's running search is left
   * alone. Rejects (with a SearchError) only when no source answered.
   */
  quick(query, { categories = [] } = {}) {
    const text = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
    if (!text) return Promise.reject(new Error('Empty search.'));
    const cats = [...new Set(categories.filter((c) => Number.isInteger(c) && c > 0 && c < 200_000))].sort();
    const s = this.settings?.settings.search ?? { hideAdult: true, resultsPerSearch: 100 };
    const cacheKey = JSON.stringify([text.toLowerCase(), cats, s.hideAdult, Boolean(this.audioConverts)]);
    this.#evict();
    const hit = this.cache.get(cacheKey);
    if (hit) return Promise.resolve(hit.search.response());
    if (this.quickPending.has(cacheKey)) return this.quickPending.get(cacheKey);
    const search = new Search({ id: 0, query: text, categories: cats, hideAdult: s.hideAdult, limit: Math.max(100, s.resultsPerSearch), audioConverts: this.audioConverts });
    const p = (async () => {
      await this.#run(search);
      if (search.error !== null && search.found.size === 0) throw new SearchError(search.error);
      this.cache.set(cacheKey, { at: Date.now(), search });
      return search.response();
    })().finally(() => this.quickPending.delete(cacheKey));
    this.quickPending.set(cacheKey, p);
    return p;
  }

  #evict() {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at > CACHE_TTL_MS) this.cache.delete(k);
  }

  /** Runs `fn` once a request to `host` may start: starts are spaced, requests may overlap. */
  #paced(host, fn) {
    const turn = (this.turns.get(host) ?? Promise.resolve()).then(async () => {
      const wait = HOST_GAP_MS - (Date.now() - (this.lastRequest.get(host) ?? 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest.set(host, Date.now());
    });
    this.turns.set(host, turn);
    return turn.then(fn);
  }

  /**
   * Asks every source at once; each one's results are merged as it answers. Finishes the search
   * when all have answered or failed: with no error if any answered, else with what went wrong.
   */
  async #run(search) {
    search.total = this.sources.length;
    search.notify();
    const errors = [];
    await Promise.all(
      this.sources.map(async (source) => {
        let results = [];
        let error = null;
        try {
          results = await this.#paced(source.host, () =>
            source.search({
              query: search.query,
              categories: search.categories,
              limit: search.limit,
              hideAdult: search.hideAdult,
              userAgent: this.userAgent,
              signal: search.controller.signal,
              fetchImpl: this.fetchImpl,
            }),
          );
        } catch (err) {
          if (search.controller.signal.aborted) return;
          error = describeError(err);
          errors.push(error);
        }
        if (search.done) return;
        search.completed += 1;
        search.indexers.push({ name: source.name, results: results.length, error });
        search.absorb(results, source.name);
        search.notify();
      }),
    );
    if (search.done) return;
    const answered = search.indexers.some((i) => i.error === null);
    search.finish(answered || search.found.size > 0 ? null : errors[0] ?? 'No index answered.');
  }
}

/** What went wrong with a search or one source, as the window says it. */
export function describeError(err) {
  if (err instanceof SearchError) return err.message;
  const m = err?.message ?? String(err);
  if (/aborted|timeout|timed out/i.test(m)) return 'The torrent indexes did not answer in time.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH/i.test(m)) return 'The torrent indexes could not be reached. Check your connection.';
  if (/answered 429/.test(m)) return 'Too many searches in a short time; wait a moment.';
  if (/answered 5\d\d/.test(m)) return 'The torrent indexes are having trouble; try again later.';
  return `Search failed: ${m}`;
}

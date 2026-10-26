// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Search over the public index at search.emberglow.tech (a JSON API over Jackett). One request
// per search: the server-sent event stream `/search/stream` answers with one `indexer` event
// per indexer as it finishes, then `done`. Results are merged and ranked here as they arrive,
// and reported to the window at most every 150 ms. Without the stream, `/search` is asked
// once. Finished searches are kept for 10 minutes, like the service's own cache.

import { EventEmitter } from 'node:events';
import { kindOfCategoryIds, parseQuality, rank, reason, watchScore } from '../shared/quality.js';

export const DEFAULT_BASE_URL = 'https://search.emberglow.tech';
const PROGRESS_INTERVAL_MS = 150;
const CACHE_TTL_MS = 10 * 60 * 1000;
const STREAM_TIMEOUT_MS = 30_000;
const FIRST_EVENT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_LENGTH = 200;
const MIN_REQUEST_GAP_MS = 1100;

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
  constructor({ id, query, categories, hideAdult, limit, baseUrl, audioConverts = false }) {
    super();
    this.id = id;
    this.query = query;
    this.categories = categories;
    this.hideAdult = hideAdult;
    this.limit = limit;
    this.baseUrl = baseUrl;
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

  url(path) {
    const u = new URL(path, this.baseUrl);
    u.searchParams.set('q', this.query);
    u.searchParams.set('limit', String(this.limit));
    for (const c of this.categories) u.searchParams.append('category', String(c));
    return u;
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

  /**
   * A `magnet` event: the magnet link (and info hash) of a result that was keyed by its
   * download link. The result is re-keyed by its hash, merging with one already found.
   */
  resolveMagnet(body) {
    const download = httpsOnly(body?.download);
    const magnet = strOrNull(body?.magnet, 8192);
    const infoHash = strOrNull(body?.infohash, 40);
    if (!download) return;
    const hash = infoHash && HASH_RE.test(infoHash) ? infoHash.toLowerCase() : /xt=urn:btih:([0-9a-fA-F]{40})/.exec(magnet ?? '')?.[1]?.toLowerCase() ?? null;
    if (!hash) return;
    const key = `download:${download}`;
    const c = this.found.get(key);
    if (!c) return;
    this.found.delete(key);
    c.infoHash = hash;
    c.magnet = magnet && /^magnet:\?/i.test(magnet) ? magnet : `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(c.title)}`;
    c.link = c.magnet;
    c.key = hash;
    const existing = this.found.get(hash);
    if (!existing) {
      this.found.set(hash, c);
      return;
    }
    for (const name of c.indexers) if (!existing.indexers.includes(name)) existing.indexers.push(name);
    if ((c.seeders ?? -1) > (existing.seeders ?? -1)) {
      existing.seeders = c.seeders;
      existing.peers = c.peers;
    }
    existing.sizeBytes ??= c.sizeBytes;
    existing.download ??= c.download;
    existing.detailsUrl ??= c.detailsUrl;
    existing.published ??= c.published;
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
  constructor({ settings, baseUrl = DEFAULT_BASE_URL } = {}) {
    this.settings = settings;
    this.baseUrl = baseUrl;
    this.current = null;
    /** @type {Map<string, {at:number, search:Search}>} */
    this.cache = new Map();
    this.indexerCount = null;
    this.indexerCountAt = 0;
    this.lastRequestAt = 0;
    /** Requests take turns for the spacing between them. */
    this.paceChain = Promise.resolve();
    /** The app's own searches in flight, so two asking the same share one request. */
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
    const search = new Search({ id, query: text, categories: cats, hideAdult: s.hideAdult, limit: s.resultsPerSearch, baseUrl: this.baseUrl, audioConverts: this.audioConverts });
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
   * A search for the app's own use (the Browse page, title pages), not the user's: one plain
   * request, paced with everything else, never shown as progress, cached like any search. The
   * user's running search is left alone.
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
    const search = new Search({ id: 0, query: text, categories: cats, hideAdult: s.hideAdult, limit: Math.max(100, s.resultsPerSearch), baseUrl: this.baseUrl, audioConverts: this.audioConverts });
    const p = (async () => {
      await this.#pace();
      await this.#plain(search);
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

  /** Waits until the index may be asked again; callers take turns, so none jumps the gap. */
  #pace() {
    const run = async () => {
      const wait = MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    };
    this.paceChain = this.paceChain.then(run, run);
    return this.paceChain;
  }

  async #run(search) {
    this.#indexerCount(search.controller.signal).then((n) => {
      if (n && !search.done) {
        search.total = n;
        search.notify();
      }
    });
    await this.#pace();
    if (search.controller.signal.aborted) return;
    let streamed = false;
    try {
      streamed = await this.#stream(search);
    } catch (err) {
      if (search.controller.signal.aborted) return;
      if (search.found.size > 0 || streamed) {
        search.finish(null);
        return;
      }
    }
    if (search.done) return;
    if (streamed) {
      search.finish(null);
      return;
    }
    await this.#pace();
    if (search.controller.signal.aborted) return;
    await this.#plain(search);
  }

  /** Reads `/search/stream`. Resolves true once at least one event was understood. */
  async #stream(search) {
    const signal = search.controller.signal;
    const timeout = AbortSignal.timeout(STREAM_TIMEOUT_MS);
    const res = await fetch(search.url('/search/stream'), {
      signal: AbortSignal.any([signal, timeout]),
      headers: { Accept: 'text/event-stream', 'User-Agent': 'Torflix/0.3.0' },
    });
    if (!res.ok || !res.body) throw new Error(`search service answered ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) throw new Error('no event stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let total = 0;
    let gotEvent = false;
    let firstTimer = null;
    const firstEvent = new Promise((_, reject) => {
      firstTimer = setTimeout(() => reject(new Error('no first event')), FIRST_EVENT_TIMEOUT_MS);
    });
    firstEvent.catch(() => {});
    const handle = (event, data) => {
      let body;
      try {
        body = JSON.parse(data);
      } catch {
        return;
      }
      if (!gotEvent) {
        gotEvent = true;
        clearTimeout(firstTimer);
      }
      if (event === 'indexer') {
        search.completed += 1;
        const name = strOrNull(body?.name, 100) ?? strOrNull(body?.id, 100) ?? 'indexer';
        const results = Array.isArray(body?.results) ? body.results : [];
        search.indexers.push({ name, results: results.length, error: strOrNull(body?.error, 300) });
        search.absorb(results, name);
        search.notify();
      } else if (event === 'magnet') {
        // The service looked up the magnet link of a result it offered only as a download link.
        search.resolveMagnet(body);
        search.notify();
      } else if (event === 'done') {
        if (Array.isArray(body?.indexers) && body.indexers.length > 0) {
          search.indexers = body.indexers.map((i) => ({
            name: strOrNull(i?.name, 100) ?? strOrNull(i?.id, 100) ?? 'indexer',
            results: typeof i?.results === 'number' ? i.results : 0,
            error: strOrNull(i?.error, 300),
          }));
          search.total = search.indexers.length;
          search.completed = search.total;
        }
        if (Array.isArray(body?.results)) search.absorb(body.results, null);
        search.finish(null);
      } else if (event === 'error') {
        search.finish(strOrNull(body?.error ?? body?.message, 300) ?? 'The search service is unavailable.');
      }
    };
    for (;;) {
      const next = reader.read();
      const { value, done } = gotEvent ? await next : await Promise.race([next, firstEvent]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let event = 'message';
        const data = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) handle(event, data.join('\n'));
      }
      if (search.done) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    clearTimeout(firstTimer);
    return gotEvent;
  }

  async #plain(search) {
    const res = await fetch(search.url('/search'), {
      signal: AbortSignal.any([search.controller.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]),
      headers: { Accept: 'application/json', 'User-Agent': 'Torflix/0.3.0' },
    });
    if (!res.ok) throw new Error(`search service answered ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body?.indexers)) {
      search.indexers = body.indexers.map((i) => ({
        name: strOrNull(i?.name, 100) ?? strOrNull(i?.id, 100) ?? 'indexer',
        results: typeof i?.results === 'number' ? i.results : 0,
        error: strOrNull(i?.error, 300),
      }));
    }
    search.absorb(body?.results, null);
    search.total = search.indexers.length;
    search.completed = search.total;
    search.finish(null);
  }

  async #indexerCount(signal) {
    if (this.indexerCount && Date.now() - this.indexerCountAt < CACHE_TTL_MS) return this.indexerCount;
    try {
      const res = await fetch(new URL('/indexers', this.baseUrl), { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (!res.ok) return null;
      const body = await res.json();
      const n = Array.isArray(body?.indexers) ? body.indexers.length : typeof body?.count === 'number' ? body.count : null;
      if (n) {
        this.indexerCount = n;
        this.indexerCountAt = Date.now();
      }
      return n;
    } catch {
      return null;
    }
  }
}

function describeError(err) {
  const m = err?.message ?? String(err);
  if (/aborted|timeout/i.test(m)) return 'The search service did not answer in time.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(m)) return 'The search service could not be reached. Check your connection.';
  if (/answered 429/.test(m)) return 'Too many searches in a short time; wait a moment.';
  if (/answered 5\d\d/.test(m)) return 'The search service is having trouble; try again later.';
  return `Search failed: ${m}`;
}

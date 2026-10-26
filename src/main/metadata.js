// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Posters and information for titles: films from Wikipedia and Wikidata, series (with seasons
// and episodes) from TVmaze. None of them needs a key. They are asked through the Torflix
// metadata service (meta/, on Vercel), whose CDN keeps one answer per title for every user, so
// the sources hear from Torflix once per title rather than once per viewer; when the service
// cannot be reached, or Settings says so, the same code (src/shared/meta) asks the sources
// directly, paced. Answers are kept on disk: films for a week, running series for half a day.
// A failure that may pass (offline, a busy source) is never kept.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { JsonStore } from './store.js';
import { parseRelease, titleKey } from '../shared/release.js';
import { MetaError, userAgent } from '../shared/meta/util.js';
import { httpGet } from '../shared/meta/http.js';
import { META_VERSION, resolveTitle, filmById, showEpisodes, servicePath, episodesPath, filmByIdPath } from '../shared/meta/resolve.js';
import { normalizeTvmaze, isRunning } from '../shared/meta/tvmaze.js';

export { MetaError as MetadataError };
export { normalizeTvmaze } from '../shared/meta/tvmaze.js';
export { normalizeWikipedia, wikipediaMatches } from '../shared/meta/wikipedia.js';

const TVMAZE = 'https://api.tvmaze.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = { film: 7 * DAY_MS, running: DAY_MS / 2, ended: 14 * DAY_MS, missing: DAY_MS };
/** After a failure that may pass, the same title is not asked again for this long. */
const COOL_OFF_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 3000;
const MAX_EPISODE_LISTS = 40;
const SAVE_DELAY_MS = 3000;
const SERVICE_TIMEOUT_MS = 8000;
/** Requests to the service at once (its answers mostly come from the CDN). */
const SERVICE_CONCURRENCY = 6;
/** Gaps between direct requests to one host, so no source is hammered. */
const PACE_MS = { 'api.tvmaze.com': 500, 'en.wikipedia.org': 250, 'www.wikidata.org': 250 };

function titleCacheKey({ kind, title, year }) {
  const k = kind === 'movie' || kind === 'tv' ? kind : 'unknown';
  const y = Number.isInteger(year) ? year : null;
  return { k, y, key: `title:${k}:${titleKey(String(title ?? '').trim())}:${y ?? ''}` };
}

const ttlFor = (info) =>(!info ? TTL_MS.missing : info.kind === 'tv' ? (isRunning(info) ? TTL_MS.running : TTL_MS.ended) : TTL_MS.film);

/** A lookup that waits its turn: the open title page's go first, Browse's background ones last. */
class Lanes {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queues = { page: [], card: [], background: [] };
  }

  run(lane, fn) {
    return new Promise((resolve, reject) => {
      (this.queues[lane] ?? this.queues.card).push({ fn, resolve, reject });
      this.#next();
    });
  }

  #next() {
    while (this.running < this.concurrency) {
      const job = this.queues.page.shift() ?? this.queues.card.shift() ?? this.queues.background.shift();
      if (!job) return;
      this.running++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.#next();
        });
    }
  }
}

export class Metadata extends EventEmitter {
  constructor({ dataDir, settings, version = '0', platform = null }) {
    super();
    this.settings = settings;
    this.userAgent = userAgent(version, platform);
    this.store = new JsonStore(path.join(dataDir, 'metadata-cache.json'), () => ({ version: 2, entries: {} }));
    const raw = this.store.loadSync();
    // Answers of the older shape (version 1) are dropped: they lack seasons, cast and more.
    this.entries = raw?.version === 2 && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    this.episodeStore = new JsonStore(path.join(dataDir, 'metadata-episodes.json'), () => ({ version: 1, lists: {} }));
    const eps = this.episodeStore.loadSync();
    this.episodeLists = eps?.version === 1 && eps.lists && typeof eps.lists === 'object' ? eps.lists : {};
    this.pending = new Map();
    this.coolOff = new Map();
    this.lanes = new Lanes(SERVICE_CONCURRENCY);
    this.lastRequest = {};
    this.chains = {};
    this.saveTimer = null;
    this.direct = httpGet(this.userAgent);
    this.#prune();
  }

  get enabled() {
    return this.settings.settings.browse.fetchInfo;
  }

  /** The service's address, or null to ask the sources directly. */
  get service() {
    const url = this.settings.settings.browse.metaService;
    return typeof url === 'string' && url.length > 0 ? url.replace(/\/+$/, '') : null;
  }

  #prune() {
    const now = Date.now();
    for (const [k, e] of Object.entries(this.entries)) {
      if (!e || typeof e.at !== 'number' || typeof e.ttl !== 'number' || now - e.at > e.ttl) delete this.entries[k];
    }
    const keys = Object.keys(this.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => this.entries[a].at - this.entries[b].at);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.entries[k];
    }
  }

  #fresh(key) {
    const e = this.entries[key];
    return e && Date.now() - e.at <= e.ttl ? e : null;
  }

  #remember(key, value, ttl) {
    this.entries[key] = { at: Date.now(), ttl, value };
    this.#saveSoon();
    return value;
  }

  /** Writes the caches a few seconds after the last change, not on every answer. */
  #saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.store.save({ version: 2, entries: this.entries });
      this.episodeStore.save({ version: 1, lists: this.episodeLists });
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Direct requests: one at a time per host, spaced. */
  #paced(url) {
    const host = new URL(url).host;
    const run = async () => {
      const wait = (PACE_MS[host] ?? 250) - (Date.now() - (this.lastRequest[host] ?? 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest[host] = Date.now();
      return this.direct(url);
    };
    const p = (this.chains[host] ?? Promise.resolve()).then(run, run);
    this.chains[host] = p.catch(() => {});
    return p;
  }

  /** The service's answer for a path: the body, or null for "not found"; a MetaError otherwise. */
  async #ask(pathname) {
    let res;
    try {
      res = await fetch(`${this.service}${pathname}`, { headers: { Accept: 'application/json', 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
    } catch {
      throw new MetaError('network', 'The Torflix metadata service could not be reached.');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new MetaError('http', `The Torflix metadata service answered ${res.status}.`);
    const body = await res.json().catch(() => null);
    if (body?.v !== META_VERSION) throw new MetaError('http', 'The Torflix metadata service answered in another format.');
    return body;
  }

  /**
   * Runs one lookup: from the service when there is one (falling back to the sources if it
   * fails), else from the sources. `viaService` returns the answer from the service's body.
   */
  async #lookup(lane, servicePaths, viaService, viaSources) {
    if (this.service) {
      try {
        return await this.lanes.run(lane, async () => {
          for (const p of servicePaths) {
            const body = await this.#ask(p);
            const value = body ? viaService(body) : null;
            if (value) return value;
          }
          return null;
        });
      } catch (err) {
        if (!(err instanceof MetaError)) throw err;
        console.warn(`[metadata] ${err.message} Asking the sources directly.`);
      }
    }
    return viaSources((url) => this.#paced(url));
  }

  /** Caches, de-duplicates and cools off one keyed lookup. */
  #once(key, ttlOf, run) {
    const hit = this.#fresh(key);
    if (hit) return Promise.resolve(hit.value);
    if (this.pending.has(key)) return this.pending.get(key);
    const cooling = this.coolOff.get(key);
    if (cooling && Date.now() < cooling) return Promise.reject(new MetaError('coolOff', 'Asked a moment ago; will ask again later.'));
    const p = run()
      .then((value) => this.#remember(key, value, ttlOf(value)))
      .catch((err) => {
        this.coolOff.set(key, Date.now() + COOL_OFF_MS);
        throw err;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /**
   * Everything known about a title, `{ kind, title, year }` (a series when `kind` is not said
   * and TVmaze knows the name), or null when nothing fits. Rejects (with a MetaError) when the
   * sources could not be asked: try again later.
   */
  title({ kind, title, year = null }, { lane = 'card' } = {}) {
    if (!this.enabled) return Promise.resolve(null);
    const name = String(title ?? '').trim();
    if (name.length < 2) return Promise.resolve(null);
    const { k, y, key } = titleCacheKey({ kind, title: name, year });
    const paths = (k === 'unknown' ? ['tv', 'movie'] : [k]).map((kk) => servicePath(kk, name, y)).filter(Boolean);
    return this.#once(key, ttlFor, () =>
      this.#lookup(
        lane,
        paths,
        (body) => (body.found ? body.info : null),
        (get) => resolveTitle(get, { kind: k, title: name, year: y }),
      ),
    );
  }

  /** What is already known about a title, asking no one: the information, null, or undefined. */
  peek({ kind, title, year = null }) {
    return this.#fresh(titleCacheKey({ kind, title, year }).key)?.value;
  }

  /** A film by its Wikidata item (the titles a film page links to). */
  byWikidata(qid, { lane = 'page' } = {}) {
    if (!this.enabled) return Promise.resolve(null);
    return this.#once(`wd:${qid}`, ttlFor, () =>
      this.#lookup(
        lane,
        [filmByIdPath(qid)],
        (body) => (body.found ? body.info : null),
        (get) => filmById(get, qid),
      ),
    );
  }

  /** A series' episodes, by its TVmaze id. */
  async episodes(tvmazeId, { lane = 'page' } = {}) {
    if (!this.enabled || !Number.isInteger(tvmazeId)) return [];
    const kept = this.episodeLists[tvmazeId];
    if (kept && Date.now() - kept.at <= TTL_MS.running) return kept.episodes;
    const episodes = await this.#lookup(
      lane,
      [episodesPath(tvmazeId)],
      (body) => (Array.isArray(body.episodes) ? body.episodes : null),
      (get) => showEpisodes(get, tvmazeId),
    );
    const list = episodes ?? [];
    this.episodeLists[tvmazeId] = { at: Date.now(), episodes: list };
    const ids = Object.keys(this.episodeLists);
    if (ids.length > MAX_EPISODE_LISTS) {
      ids.sort((a, b) => this.episodeLists[a].at - this.episodeLists[b].at);
      for (const id of ids.slice(0, ids.length - MAX_EPISODE_LISTS)) delete this.episodeLists[id];
    }
    this.#saveSoon();
    return list;
  }

  /** The lookup Browse cards and search posters make: a release's title, with no wait if known. */
  lookup(parsed, opts) {
    if (!parsed || typeof parsed.title !== 'string') return Promise.resolve(null);
    return this.title({ kind: parsed.kind, title: parsed.title, year: parsed.year }, opts);
  }

  /** The same, for a torrent's release name (search posters); never rejects. */
  lookupRelease(name) {
    const parsed = parseRelease(name);
    return parsed ? this.lookup(parsed).catch(() => null) : Promise.resolve(null);
  }

  /** Today's TVmaze schedule (`/schedule/web` for streaming, `/schedule` for TV) as titles. */
  async schedule(kind) {
    const date = new Date().toISOString().slice(0, 10);
    const url = new URL(`${TVMAZE}${kind === 'web' ? '/schedule/web' : '/schedule'}`);
    url.search = new URLSearchParams({ date, country: this.settings.settings.browse.region }).toString();
    const body = await this.#paced(url.toString());
    const out = [];
    for (const ep of Array.isArray(body) ? body : []) {
      const t = normalizeTvmaze(ep?._embedded?.show ?? ep?.show, ep);
      if (t) out.push(t);
    }
    return out;
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.store.save({ version: 2, entries: this.entries });
      this.episodeStore.save({ version: 1, lists: this.episodeLists });
    }
    return Promise.all([this.store.flush(), this.episodeStore.flush()]);
  }
}

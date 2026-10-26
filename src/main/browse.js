// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Browse page: what performs best on the swarm right now. A few broad searches of the
// public index ("1080p", this year, "S01", in the film and series categories) are read into
// titles: each torrent's release name is parsed, torrents of the same film or series are
// grouped, and groups are ranked by their seeders. The rows come back at once with the
// torrents; posters and information arrive afterwards (metadata.js: the hero and first rows
// first, several at a time) and are pushed to the window as they do. Nothing here needs a key.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { JsonStore } from './store.js';
import { parseRelease, titleKey } from '../shared/release.js';
import { pickable } from '../shared/quality.js';
import { META_VERSION } from '../shared/meta/resolve.js';

const ROWS_TTL_MS = 30 * 60 * 1000;
const ROW_SIZE = 24;
const TORRENTS_PER_TITLE = 8;
const MOVIES = [2000];
const SERIES = [5000];

/** The index queries behind the rows. */
function queries() {
  const year = new Date().getFullYear();
  return [
    { id: 'films-1080p', q: '1080p', categories: MOVIES, kind: 'movie' },
    { id: 'films-year', q: String(year), categories: MOVIES, kind: 'movie' },
    { id: 'films-4k', q: '2160p', categories: MOVIES, kind: 'movie' },
    { id: 'series-1080p', q: '1080p', categories: SERIES, kind: 'tv' },
    { id: 'series-year', q: String(year), categories: SERIES, kind: 'tv' },
    { id: 'series-s01', q: 'S01', categories: SERIES, kind: 'tv' },
  ];
}

/**
 * A title's information as a Browse card and the hero use it: the poster, the large picture,
 * a short overview and a few facts. A title page asks for the rest (cast, seasons, episodes),
 * so a row of 24 titles does not carry it to the page.
 */
export function cardMeta(info) {
  if (!info) return null;
  const overview = typeof info.overview === 'string' && info.overview.length > 400 ? `${info.overview.slice(0, 399)}…` : info.overview ?? null;
  return {
    v: info.v,
    source: info.source,
    sourceId: info.sourceId,
    kind: info.kind,
    title: info.title,
    year: info.year,
    overview,
    poster: info.poster ?? null,
    image: info.image ?? null,
    backdrop: info.backdrop ?? null,
    rating: info.rating ?? null,
    genres: (info.genres ?? []).slice(0, 4),
    network: info.network ?? null,
    status: info.status ?? null,
    runtimeMins: info.runtimeMins ?? null,
    link: info.link ?? null,
    episode: info.episode ?? null,
  };
}

/** Ranks a title's torrents for its Play button: playable first, then the most seeded. */
export const bestScore = (t) => (pickable(t) ? 1e6 : 0) + (t.seeders ?? 0);

/** Folds group `from` into group `into`. */
function mergeGroup(into, from) {
  into.seeders += from.seeders;
  into.peers += from.peers;
  into.torrents.push(...from.torrents);
  if (from.titleSeeders > into.titleSeeders) {
    into.titleSeeders = from.titleSeeders;
    into.title = from.title;
  }
  into.year ??= from.year;
}

/**
 * Groups search results into titles. Releases of one title are found however they spell it
 * (see `titleKey`); a film's undated releases join its dated group when there is just one.
 * Each title keeps its best torrents (most seeded first) and the sum of their seeders, which
 * is what "top performing" ranks by, and shows the spelling of its most seeded release.
 */
export function groupResults(results, kind, { perTitle = TORRENTS_PER_TITLE } = {}) {
  const groups = new Map();
  for (const r of results) {
    const parsed = parseRelease(r.title);
    if (!parsed) continue;
    if (kind === 'movie' && parsed.kind === 'tv') continue;
    if (kind === 'tv' && parsed.kind === 'movie' && parsed.season === null) continue;
    if (r.quality?.kind === 'notVideo' || r.quality?.kind === 'audio') continue;
    const tkey = titleKey(parsed.title);
    if (!tkey) continue;
    // A series is one title across its seasons and years; a film is a title and a year.
    const key = kind === 'tv' ? `tv:${tkey}` : `movie:${tkey}:${parsed.year ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, base: `${kind}:${tkey}`, title: parsed.title, titleSeeders: -1, year: parsed.year, kind, seeders: 0, peers: 0, torrents: [], best: null, meta: null };
      groups.set(key, g);
    }
    if ((r.seeders ?? 0) > g.titleSeeders) {
      g.titleSeeders = r.seeders ?? 0;
      g.title = parsed.title;
    }
    g.year ??= parsed.year;
    g.seeders += r.seeders ?? 0;
    g.peers += r.peers ?? 0;
    g.torrents.push({
      title: r.title,
      key: r.key,
      link: r.link,
      magnet: r.magnet,
      infoHash: r.infoHash,
      seeders: r.seeders,
      peers: r.peers,
      sizeBytes: r.sizeBytes,
      quality: r.quality,
      reason: r.reason,
      indexers: r.indexers,
      published: r.published,
      season: parsed.season,
      episode: parsed.episode,
    });
  }
  if (kind === 'movie') {
    for (const g of [...groups.values()]) {
      if (g.year !== null) continue;
      const dated = [...groups.values()].filter((o) => o !== g && o.base === g.base && o.year !== null);
      if (dated.length !== 1) continue;
      mergeGroup(dated[0], g);
      groups.delete(g.key);
    }
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.best = g.torrents.reduce((best, t) => (best && bestScore(best) >= bestScore(t) ? best : t), null);
    g.torrents.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
    g.torrents = g.torrents.slice(0, perTitle);
    delete g.titleSeeders;
    delete g.base;
  }
  out.sort((a, b) => b.seeders - a.seeders);
  return out;
}

export class Browse extends EventEmitter {
  constructor({ dataDir, search, metadata, settings }) {
    super();
    this.search = search;
    this.metadata = metadata;
    this.settings = settings;
    this.store = new JsonStore(path.join(dataDir, 'browse-cache.json'), () => null);
    const cached = this.store.loadSync();
    this.cachedRows = cached && typeof cached === 'object' && Array.isArray(cached.rows) ? cached : null;
    // Information of an older shape is looked up again, and so is everything a past run gave up on.
    for (const t of this.cachedRows ? [this.cachedRows.hero, ...this.cachedRows.rows.flatMap((r) => r.items)] : []) {
      if (!t) continue;
      if (t.meta && t.meta.v !== META_VERSION && !String(t.key).startsWith('tvmaze:')) t.meta = null;
      delete t.metaTried;
    }
    this.building = null;
    this.visible = false;
    /** Keys whose information is being looked up. */
    this.enriching = new Set();
    /** Titles by key, across rows, so information is fetched once and found again for details. */
    this.titles = new Map();
    if (this.cachedRows) this.#index(this.cachedRows);
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
  }

  /** The rows, from the cache when fresh (building in the background otherwise). */
  async rows({ refresh = false } = {}) {
    const fresh = this.cachedRows && Date.now() - this.cachedRows.fetchedAt < ROWS_TTL_MS;
    if (fresh && !refresh) {
      this.#enrichAll(this.cachedRows);
      return this.#view(this.cachedRows);
    }
    if (!this.building) {
      this.building = this.#build().finally(() => {
        this.building = null;
      });
    }
    if (this.cachedRows && !refresh) {
      // Stale rows now, fresh ones once built.
      this.building.then((rows) => this.emit('rows', this.#view(rows))).catch(() => {});
      return this.#view(this.cachedRows);
    }
    return this.#view(await this.building);
  }

  #view(rows) {
    return {
      fetchedAt: rows.fetchedAt,
      error: rows.error,
      hero: rows.hero ? this.#withMeta(rows.hero) : null,
      rows: rows.rows.map((r) => ({ id: r.id, title: r.title, items: r.items.map((t) => this.#withMeta(t)) })),
    };
  }

  /** A title for the page: with what is known about it, as a card needs it. */
  #withMeta(t) {
    const known = this.titles.get(t.key) ?? t;
    // Found on an earlier run (or for another row): there at once, with the rows.
    if (!known.meta && this.settings.settings.browse.fetchInfo) {
      const cached = this.metadata.peek({ kind: t.kind, title: t.title, year: t.year });
      if (cached) known.meta = cached;
    }
    return { ...t, meta: cardMeta(known.meta ?? t.meta ?? null) };
  }

  /**
   * Indexes the rows' titles by key. Fresh rows replace older titles (their torrents are newer),
   * keeping the information already found; within one build, the first row a title is in wins
   * (the top rows merge every list's torrents).
   */
  #index(rows) {
    const seen = new Set();
    const put = (t) => {
      if (seen.has(t.key)) return;
      seen.add(t.key);
      const old = this.titles.get(t.key);
      if (old && old !== t) {
        t.meta ??= old.meta ?? null;
        t.metaTried ??= old.metaTried;
      }
      this.titles.set(t.key, t);
    };
    if (rows.hero) put(rows.hero);
    for (const r of rows.rows) for (const t of r.items) put(t);
  }

  async #build() {
    const settings = this.settings.settings;
    const rows = [];
    let error = null;
    const byId = {};
    const results = await Promise.all(
      queries().map(async (spec) => {
        try {
          const response = await this.search.quick(spec.q, { categories: spec.categories });
          return { spec, groups: groupResults(response.results, spec.kind) };
        } catch (err) {
          error ??= err?.message ?? String(err);
          return { spec, groups: [] };
        }
      }),
    );
    for (const { spec, groups } of results) byId[spec.id] = groups;
    const merge = (...lists) => {
      const seen = new Map();
      for (const list of lists) {
        for (const g of list) {
          const prev = seen.get(g.key);
          if (!prev) seen.set(g.key, { ...g, torrents: [...g.torrents] });
          else {
            const have = new Set(prev.torrents.map((t) => t.key));
            for (const t of g.torrents) if (!have.has(t.key)) prev.torrents.push(t);
            prev.torrents.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
            prev.torrents = prev.torrents.slice(0, TORRENTS_PER_TITLE);
            prev.seeders = Math.max(prev.seeders, g.seeders);
            if ((g.best?.seeders ?? 0) > (prev.best?.seeders ?? 0) && pickable(g.best ?? {}) === pickable(prev.best ?? {})) prev.best = g.best;
          }
        }
      }
      return [...seen.values()].sort((a, b) => b.seeders - a.seeders);
    };
    const films = merge(byId['films-1080p'] ?? [], byId['films-year'] ?? [], byId['films-4k'] ?? []);
    const series = merge(byId['series-1080p'] ?? [], byId['series-year'] ?? [], byId['series-s01'] ?? []);
    const year = new Date().getFullYear();
    const row = (id, title, items) => (items.length > 0 ? rows.push({ id, title, items: items.slice(0, ROW_SIZE) }) : null);
    row('top-films', 'Top films on the swarm', films);
    row('top-series', 'Top series on the swarm', series);
    row('new-films', `New films of ${year}`, (byId['films-year'] ?? []).filter((g) => g.year === year));
    row('new-series', `Series of ${year}`, (byId['series-year'] ?? []).filter((g) => g.year === year || g.torrents.some((t) => /\b(S0?1)\b/i.test(t.title))));
    row('films-4k', 'Films in 4K', byId['films-4k'] ?? []);
    row('complete-seasons', 'Complete seasons', (byId['series-s01'] ?? []).filter((g) => g.torrents.some((t) => t.episode === null)));
    if (settings.browse.fetchInfo) {
      try {
        const [web, tv] = await Promise.all([this.metadata.schedule('web').catch(() => []), this.metadata.schedule('tv').catch(() => [])]);
        const asTitle = (t) => ({ key: `tvmaze:${t.sourceId}`, title: t.title, year: t.year, kind: 'tv', seeders: null, peers: null, torrents: [], best: null, meta: t, scheduled: t.episode });
        const keep = (list) => {
          const seen = new Set();
          return list
            .filter((t) => t.poster && (!t.type || ['Scripted', 'Animation', 'Documentary'].includes(t.type)) && !seen.has(t.sourceId) && seen.add(t.sourceId))
            .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0))
            .slice(0, ROW_SIZE)
            .map(asTitle);
        };
        row('streaming-today', 'Streaming today', keep(web));
        row('tv-tonight', 'On TV tonight', keep(tv));
      } catch (err) {
        error ??= err?.message ?? String(err);
      }
    }
    const hero = films[0] ?? series[0] ?? null;
    const built = { fetchedAt: Date.now(), error, hero, rows };
    this.cachedRows = built;
    this.#index(built);
    this.store.save(built);
    this.#enrichAll(built);
    return built;
  }

  /** Asks for every title's information: the hero and first two rows first, the rest after. */
  #enrichAll(rows) {
    if (!this.settings.settings.browse.fetchInfo) return;
    const first = [rows.hero, ...(rows.rows[0]?.items ?? []), ...(rows.rows[1]?.items ?? [])].filter(Boolean);
    for (const t of first) this.#enrich(t.key, 'card');
    for (const r of rows.rows.slice(2)) for (const t of r.items) this.#enrich(t.key, 'background');
  }

  #enrich(key, lane) {
    const t = this.titles.get(key);
    if (!t || t.meta || t.metaTried || this.enriching.has(key)) return;
    this.enriching.add(key);
    this.metadata
      .title({ kind: t.kind, title: t.title, year: t.year }, { lane })
      .then((meta) => {
        t.metaTried = true;
        if (!meta) return;
        t.meta = meta;
        this.emit('title-meta', { key, meta: cardMeta(meta) });
      })
      // Offline or a busy source: asked again when the rows are next shown.
      .catch(() => {})
      .finally(() => this.enriching.delete(key));
  }

  flush() {
    return this.store.flush();
  }
}

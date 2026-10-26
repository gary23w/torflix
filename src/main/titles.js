// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Title pages: a film or series with its information, every copy the swarm has of it, what of
// it was watched (to resume, per film or per episode), and, for a series, which copy plays a
// given episode: an episode's own torrent, a season pack (and the file in it), or one found by
// searching the index for "Title S01E03".

import { titleKey } from '../shared/release.js';
import { copyIdentity } from '../shared/copies.js';
import { pickable, watchScore } from '../shared/quality.js';
import { episodeTag } from '../shared/episodes.js';
import { groupResults, bestScore } from './browse.js';

const MOVIES = [2000];
const SERIES = [5000];
/** Copies a title page keeps (a series has many episodes and packs). */
const COPIES_PER_TITLE = 60;
const COPIES_TTL_MS = 10 * 60 * 1000;
/** Positions within this of either end are not offered to resume (as the library decides). */
const RESUME_MARGIN_SECS = 10;

/** A title page's identity: its kind, the key of its title, and (films) its year. */
export function identityOf({ kind, title, year }) {
  return { kind: kind === 'tv' ? 'tv' : 'movie', key: titleKey(title), year: Number.isInteger(year) ? year : null };
}

const resumable = (it) =>
  !it.completed && it.positionSecs >= RESUME_MARGIN_SECS && (it.durationSecs === null || it.positionSecs <= it.durationSecs - RESUME_MARGIN_SECS) ? it.positionSecs : null;

/**
 * What of a title the library has, most recent first: for a film, the file last opened (with
 * its resume position, if any, and whether it was watched to the end); for a series, the same
 * per episode (`episodes['S1E3']`) and the episode last opened (`last`). Items are matched by
 * their file's name, else their torrent's, however a copy spells the title.
 */
export function progressFor(items, want) {
  const out = { resume: null, watched: false, episodes: {}, last: null };
  for (const it of items) {
    const byFile = copyIdentity(it.title);
    const id = byFile && (byFile.kind !== 'tv' || byFile.episode !== null) ? byFile : (copyIdentity(it.torrentName) ?? byFile);
    if (!id || id.key !== want.key) continue;
    const entry = {
      source: it.source,
      infoHash: it.infoHash,
      fileIndex: it.fileIndex,
      title: it.title,
      torrentName: it.torrentName,
      sizeBytes: it.sizeBytes ?? null,
      positionSecs: it.positionSecs,
      durationSecs: it.durationSecs,
      completed: it.completed === true,
      resumeSecs: resumable(it),
    };
    if (want.kind === 'movie') {
      if (id.kind === 'tv' || (want.year && id.year && Math.abs(want.year - id.year) > 1)) continue;
      out.resume ??= entry;
      out.watched ||= entry.completed;
    } else {
      if (id.kind !== 'tv' || id.season === null || id.episode === null) continue;
      const k = `S${id.season}E${id.episode}`;
      out.episodes[k] ??= { ...entry, season: id.season, episode: id.episode };
      out.last ??= out.episodes[k];
    }
  }
  return out;
}

/** The best of some copies: playable first, then the watch score (seeders, quality). */
const rank = (list) => [...list].sort((a, b) => (pickable(b) ? 1 : 0) - (pickable(a) ? 1 : 0) || watchScore(b.seeders, b.peers, b.quality) - watchScore(a.seeders, a.peers, a.quality));

/**
 * The copy that plays an episode among `torrents`: its own torrent first, else a pack of its
 * season, else a pack of the whole series. Packs say which episode to pick in them.
 */
export function episodeChoice(torrents, season, episode) {
  const own = rank(torrents.filter((t) => t.season === season && t.episode === episode && t.link));
  if (own.length > 0) return { torrent: own[0], pick: null, via: 'episode' };
  const pack = rank(torrents.filter((t) => t.season === season && t.episode === null && t.link));
  if (pack.length > 0) return { torrent: pack[0], pick: { season, episode }, via: 'pack' };
  const all = rank(torrents.filter((t) => t.season === null && t.episode === null && t.link));
  if (all.length > 0) return { torrent: all[0], pick: { season, episode }, via: 'completePack' };
  return null;
}

/** Torrents of several lists, each once (one torrent listed by several indexers is one), best seeded first. */
function mergeTorrents(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const t of list ?? []) {
      const id = t?.infoHash?.toLowerCase() ?? t?.key;
      if (id && !seen.has(id)) seen.set(id, t);
    }
  }
  return [...seen.values()].sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)).slice(0, COPIES_PER_TITLE);
}

export class Titles {
  constructor({ browse, metadata, search, library }) {
    this.browse = browse;
    this.metadata = metadata;
    this.search = search;
    this.library = library;
    /** Copies found by searching, by page key: `{ at, torrents }`. */
    this.copies = new Map();
  }

  #known(key) {
    const c = this.copies.get(key);
    return c && Date.now() - c.at < COPIES_TTL_MS ? c.torrents : [];
  }

  #torrents(key) {
    return mergeTorrents(this.browse.titles.get(key)?.torrents, this.#known(key));
  }

  /** What is known now, with no request: torrents, information if cached, and progress. */
  page(req) {
    const t = this.browse.titles.get(req.key) ?? null;
    const torrents = this.#torrents(req.key);
    return {
      key: req.key,
      kind: req.kind,
      title: req.title,
      year: req.year,
      seeders: t?.seeders ?? null,
      torrents,
      best: torrents.reduce((best, x) => (best && bestScore(best) >= bestScore(x) ? best : x), null),
      info: this.metadata.peek(req) ?? t?.meta ?? null,
      progress: progressFor(this.library.list(), identityOf(req)),
    };
  }

  /** The title's information and, for a series TVmaze knows, its episodes. */
  async info(req) {
    const info = await this.metadata.title({ kind: req.kind, title: req.title, year: req.year }, { lane: 'page' });
    const tvmaze = info?.kind === 'tv' ? info.ids?.tvmaze : null;
    const episodes = Number.isInteger(tvmaze) ? await this.metadata.episodes(tvmaze).catch(() => []) : [];
    return { info, episodes };
  }

  /**
   * Every copy the index has of the title (a series: of one season, when asked), merged with
   * what Browse knows. Only releases of this very title count: the same name, and for a film
   * the same year (or none).
   */
  async findCopies(req, { season = null } = {}) {
    const tv = req.kind === 'tv';
    const query = tv ? (Number.isInteger(season) ? `${req.title} S${String(season).padStart(2, '0')}` : req.title) : `${req.title}${req.year ? ` ${req.year}` : ''}`;
    const response = await this.search.quick(query, { categories: tv ? SERIES : MOVIES });
    const want = identityOf(req);
    const groups = groupResults(response.results, want.kind, { perTitle: COPIES_PER_TITLE }).filter((g) => {
      if (titleKey(g.title) !== want.key) return false;
      return tv || !want.year || g.year === null || Math.abs(g.year - want.year) <= 1;
    });
    const torrents = mergeTorrents(this.#known(req.key), ...groups.map((g) => g.torrents));
    this.copies.set(req.key, { at: Date.now(), torrents });
    const all = this.#torrents(req.key);
    return { torrents: all, best: all.reduce((best, x) => (best && bestScore(best) >= bestScore(x) ? best : x), null) };
  }

  /**
   * The copy that plays one episode, or null: the file watched before (its data is on disk),
   * else a known copy, else one found by searching the index for "Title S01E03".
   */
  async episode(req, season, episode) {
    const watched = progressFor(this.library.list(), identityOf(req)).episodes[`S${season}E${episode}`];
    if (watched?.source) {
      return { source: watched.source, infoHash: watched.infoHash, fileIndex: watched.fileIndex, title: watched.title, torrentName: watched.torrentName, sizeBytes: watched.sizeBytes, pick: null, via: 'library' };
    }
    let choice = episodeChoice(this.#torrents(req.key), season, episode);
    if (!choice || choice.via === 'completePack') {
      const response = await this.search.quick(`${req.title} ${episodeTag(season, episode)}`, { categories: SERIES }).catch(() => null);
      const found = response ? groupResults(response.results, 'tv', { perTitle: COPIES_PER_TITLE }).filter((g) => titleKey(g.title) === identityOf(req).key) : [];
      if (found.length > 0) {
        const torrents = mergeTorrents(this.#known(req.key), ...found.map((g) => g.torrents));
        this.copies.set(req.key, { at: Date.now(), torrents });
        choice = episodeChoice(this.#torrents(req.key), season, episode) ?? choice;
      }
    }
    if (!choice) return null;
    const t = choice.torrent;
    return { source: t.link, infoHash: t.infoHash ?? null, fileIndex: null, title: t.title, torrentName: t.title, sizeBytes: t.sizeBytes ?? null, pick: choice.pick, via: choice.via };
  }
}

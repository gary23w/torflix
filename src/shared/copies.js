// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Other copies of the same title, for when the one chosen sends nothing. Seeder counts on the
// public index can be stale (a title listed with thousands of seeders whose torrent has no live
// peer), so a copy is judged by what actually arrives once it plays: if nothing has after a
// short wait, the player moves on to the next copy of the same film or episode.

import { parseRelease, titleKey } from './release.js';
import { pickable, watchScore } from './quality.js';

/** How long a copy has to start sending before another one is tried. */
export const NO_DATA_MS = 20_000;
/** Less than this received in that time counts as nothing (a 4K stream needs about 2 MB/s). */
export const NO_DATA_BYTES = 2 * 1024 * 1024;
/** Copies tried after the first, per Play. */
export const MAX_SWITCHES = 3;

/**
 * What makes two release names the same title: the title however it is spelled, and the year
 * of a film, or the season and episode of a series (a season pack matches only other packs of
 * that season). Null when the name has no recognisable title.
 */
export function copyIdentity(name) {
  const p = parseRelease(name);
  if (!p) return null;
  const key = titleKey(p.title);
  if (!key) return null;
  if (p.kind === 'tv') return { key, kind: 'tv', season: p.season, episode: p.episode, year: null };
  return { key, kind: p.kind, season: null, episode: null, year: p.year };
}

/** Whether two identities name the same film or episode. */
export function sameTitle(a, b) {
  if (!a || !b || a.key !== b.key) return false;
  if (a.kind === 'tv' || b.kind === 'tv') {
    return a.kind === b.kind && a.season === b.season && a.episode === b.episode;
  }
  // A year on both sides must agree; a copy without one is taken at its word.
  return a.year === null || b.year === null || a.year === b.year;
}

/**
 * The other copies of a title, best first: same film or episode, a magnet or link to play it,
 * not tried yet, seeded, playable and a video (not, say, its soundtrack), ranked by the same
 * watch score as search and Browse.
 * `candidates` are search results or Browse torrents (`title`, `link`, `infoHash`, `seeders`,
 * `peers`, `quality`); duplicates are dropped.
 */
export function otherCopies(name, candidates, tried = new Set()) {
  const want = copyIdentity(name);
  if (!want) return [];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const hash = c?.infoHash?.toLowerCase() ?? null;
    if (!c?.link || !hash || tried.has(hash) || seen.has(hash)) continue;
    if (!c.quality || c.quality.kind === 'audio' || !pickable(c)) continue;
    if (!sameTitle(want, copyIdentity(c.title))) continue;
    seen.add(hash);
    out.push(c);
  }
  return out.sort((a, b) => watchScore(b.seeders, b.peers, b.quality) - watchScore(a.seeders, a.peers, a.quality));
}

/**
 * Whether a copy that is playing has sent nothing: no first frame, and less than
 * `NO_DATA_BYTES` received since it started, after `NO_DATA_MS`.
 */
export function sendsNothing({ elapsedMs, firstFrame, receivedBytes }) {
  return !firstFrame && elapsedMs >= NO_DATA_MS && (receivedBytes ?? 0) < NO_DATA_BYTES;
}

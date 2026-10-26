// SPDX-License-Identifier: MIT OR Apache-2.0
//
// What a title page offers first, from what was watched of it: Resume and Play from start, or
// the next episode, or Play. Pure functions.

import { formatTime } from '../../shared/format.js';
import { episodeLabel } from '../../shared/episodes.js';

/**
 * The episode after one, by the series' episode list when it is known: the next in its season,
 * else the first of the next season; null after the last.
 */
export function nextEpisode(episodes, season, episode) {
  if (!Array.isArray(episodes) || episodes.length === 0) return { season, episode: episode + 1 };
  const i = episodes.findIndex((e) => e.season === season && e.number === episode);
  if (i < 0) return episodes.find((e) => e.season > season || (e.season === season && e.number > episode)) ?? null;
  const next = episodes[i + 1];
  return next ? { season: next.season, episode: next.number } : null;
}

/**
 * The page's main button and the one beside it (or null), each `{ label, play }`. `play` is
 * what pressing it plays:
 *   { kind: 'torrent', torrent }                      a copy (a film's best)
 *   { kind: 'item', item, positionSecs | fromStart }  a file watched before
 *   { kind: 'episode', season, episode, item?, positionSecs?, fromStart? }
 */
export function titleActions({ kind, progress, best, episodes }) {
  if (kind === 'tv') {
    const last = progress?.last ?? null;
    if (last?.resumeSecs) {
      const name = episodeLabel(last.season, last.episode);
      return {
        primary: { label: `Resume ${name} · ${formatTime(last.resumeSecs)}`, play: { kind: 'episode', season: last.season, episode: last.episode, item: last, positionSecs: last.resumeSecs } },
        secondary: { label: `${name} from the start`, play: { kind: 'episode', season: last.season, episode: last.episode, item: last, fromStart: true } },
      };
    }
    if (last) {
      const next = nextEpisode(episodes, last.season, last.episode);
      if (next) return { primary: { label: `Play ${episodeLabel(next.season, next.episode)}`, play: { kind: 'episode', ...next } }, secondary: null };
    }
    const first = Array.isArray(episodes) && episodes.length > 0 ? episodes[0] : null;
    if (first) return { primary: { label: `Play ${episodeLabel(first.season, first.number)}`, play: { kind: 'episode', season: first.season, episode: first.number } }, secondary: null };
    return { primary: { label: 'Play', play: best ? { kind: 'torrent', torrent: best } : null }, secondary: null };
  }
  const watched = progress?.resume ?? null;
  if (watched?.resumeSecs) {
    return {
      primary: { label: `Resume from ${formatTime(watched.resumeSecs)}`, play: { kind: 'item', item: watched, positionSecs: watched.resumeSecs } },
      secondary: { label: 'Play from start', play: { kind: 'item', item: watched, fromStart: true } },
    };
  }
  if (watched?.completed) return { primary: { label: 'Play again', play: { kind: 'item', item: watched, fromStart: true } }, secondary: null };
  return { primary: { label: 'Play', play: best ? { kind: 'torrent', torrent: best } : null }, secondary: null };
}

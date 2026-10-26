// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Episodes inside season packs: which file of a torrent is S01E03. Pure functions.

import { fileName, isExtra } from './files.js';

const SXXEYY = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i;
const NXNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i;
const SEASON_DIR = /(?:^|[^a-z0-9])(?:season[ ._-]?(\d{1,2})|s(\d{1,2}))(?![0-9])/i;
const EPISODE_WORD = /(?:^|[^a-z0-9])(?:episode|ep|e)[ ._-]?(\d{1,3})(?![0-9])/i;
const LEADING_NUMBER = /^(\d{1,3})(?![0-9])/;

/**
 * The season and episode a file is, from its name ("Show.S01E03.mkv", "Show 1x03.mkv") or its
 * folder and name ("Season 1/03 - Title.mkv", "S01/Episode 3.mkv"); a double episode counts as
 * its first. Null when the path does not say.
 */
export function episodeOf(path) {
  const full = String(path ?? '');
  const name = fileName(full);
  let m = SXXEYY.exec(name) ?? NXNN.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  const folder = full.slice(0, full.length - name.length);
  const dir = SEASON_DIR.exec(folder);
  const ep = EPISODE_WORD.exec(name) ?? LEADING_NUMBER.exec(name);
  if (dir && ep) return { season: Number(dir[1] ?? dir[2]), episode: Number(ep[1]) };
  m = SXXEYY.exec(full);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

/** The video file of a torrent that is that episode (the largest, if several), or null. */
export function episodeFile(files, season, episode) {
  const matches = (Array.isArray(files) ? files : []).filter((f) => {
    if (f.kind !== 'video' || isExtra(f.path)) return false;
    const e = episodeOf(f.path);
    return e !== null && e.season === season && e.episode === episode;
  });
  return matches.reduce((best, f) => (best && best.length >= f.length ? best : f), null);
}

/** "S1 E3", as the pages show an episode. */
export const episodeLabel = (season, episode) => `S${season} E${episode}`;

/** "S01E03", as releases name one (and as the index is searched for one). */
export const episodeTag = (season, episode) => `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Reads a torrent's release name ("Sintel.2010.1080p.WEB.H264-CLASSiCALHD",
// "Show.Name.S01E02.720p.WEBRip") into what a metadata provider can look up: the title, the
// year, and for series the season and episode. Pure functions.

const TAGS = new Set([
  '2160p', '1080p', '1080i', '720p', '480p', '576p', '360p', '4k', 'uhd', 'hd', 'fhd', 'sd', 'bluray', 'blu', 'ray',
  'bdrip', 'brrip', 'bdremux', 'remux', 'webdl', 'web', 'dl', 'webrip', 'rip', 'hdtv', 'pdtv', 'dvdrip', 'dvd',
  'dvd5', 'dvd9', 'hdrip', 'camrip', 'cam', 'hdcam', 'ts', 'hdts', 'tc', 'hdtc', 'telesync', 'telecine',
  'screener', 'scr', 'dvdscr', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'vp9', 'xvid', 'divx',
  '10bit', '8bit', 'hdr', 'hdr10', 'hdr10plus', 'dv', 'dovi', 'sdr', 'aac', 'aac2', 'ac3', 'eac3', 'dd', 'ddp',
  'dd5', 'ddp5', 'dts', 'truehd', 'atmos', 'mp3', 'flac', 'opus', 'multi', 'multisub', 'multisubs', 'dual',
  'dubbed', 'subbed', 'sub', 'subs', 'eng', 'english', 'ita', 'fre', 'ger', 'spa', 'rus', 'jpn', 'kor', 'hin',
  'proper', 'repack', 'rerip', 'internal', 'limited', 'extended', 'unrated', 'uncut', 'remastered', 'directors',
  'cut', 'imax', 'theatrical', 'complete', 'season', 'series', 'pack', 'mkv', 'mp4', 'avi', 'webm', 'yts', 'yify',
  'rarbg', 'ettv', 'eztv', 'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'pcok', 'hulu', 'www', 'com', 'org', 'net', 'to',
  'mx', 'lt', 'ag', 'torrent', 'torrents', 'hc', 'hardsub', 'hardsubbed', 'nordic', 'swesub', 'line', 'ld', 'md',
]);

const SEASON_EP = /^s(\d{1,2})e(\d{1,3})(?:e\d{1,3})?$/i;
const SEASON_ONLY = /^s(\d{1,2})$/i;
const SEASON_WORD = /^season$/i;
const EP_X = /^(\d{1,2})x(\d{1,3})$/i;
const YEAR = /^(19|20)\d{2}$/;

/**
 * `{ title, year, kind: 'movie' | 'tv' | 'unknown', season, episode }` for a release name, or
 * null when nothing title-like is left. The title keeps its original words.
 */
export function parseRelease(name) {
  let text = String(name ?? '').trim();
  if (!text) return null;
  // Drop a leading "[Group]" or "www.site.org - " prefix and anything in brackets.
  text = text.replace(/^\[[^\]]*\]\s*/, '').replace(/^www\.[^\s]+\s*-\s*/i, '').replace(/\[[^\]]*\]/g, ' ');
  const raw = text.split(/[.\s_]+/).filter(Boolean);
  const words = [];
  let year = null;
  let season = null;
  let episode = null;
  let kind = 'unknown';
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i].replace(/^[(\-]+|[)\-,]+$/g, '');
    if (!w) continue;
    const lower = w.toLowerCase();
    let m;
    if ((m = SEASON_EP.exec(w))) {
      season = Number(m[1]);
      episode = Number(m[2]);
      kind = 'tv';
      break;
    }
    if ((m = EP_X.exec(w)) && words.length > 0) {
      season = Number(m[1]);
      episode = Number(m[2]);
      kind = 'tv';
      break;
    }
    if ((m = SEASON_ONLY.exec(w)) && words.length > 0) {
      season = Number(m[1]);
      kind = 'tv';
      break;
    }
    if (SEASON_WORD.test(w) && /^\d{1,2}$/.test(raw[i + 1] ?? '') && words.length > 0) {
      season = Number(raw[i + 1]);
      kind = 'tv';
      break;
    }
    if (YEAR.test(w) && words.length > 0) {
      year = Number(w);
      // Everything after the year is tags, but a series may still name its episode there
      // ("Show 2026 S01E08"), so the rest is checked for one.
      for (const rest of raw.slice(i + 1)) {
        const r = rest.replace(/^[(\-]+|[)\-,]+$/g, '');
        if ((m = SEASON_EP.exec(r) ?? EP_X.exec(r))) {
          season = Number(m[1]);
          episode = Number(m[2]);
          kind = 'tv';
          break;
        }
        if ((m = SEASON_ONLY.exec(r))) {
          season = Number(m[1]);
          kind = 'tv';
          break;
        }
      }
      break;
    }
    if (TAGS.has(lower)) {
      if (words.length > 0) break;
      continue;
    }
    if (/^-/.test(raw[i]) && words.length > 0) break;
    words.push(w);
  }
  // Separators (" - ") were dropped above; hyphens inside words ("Spider-Man") are kept.
  const title = words.join(' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  if (kind === 'unknown' && year !== null) kind = 'movie';
  return { title, year, kind, season, episode };
}

/**
 * The same title however a release spells it: accents, case, punctuation and spacing are
 * ignored, and "&" reads as "and" ("Spider-Man: Brand New Day" = "Spider Man Brand New Day").
 */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A lookup key for caching: the title's key plus year and kind. */
export function releaseKey(parsed) {
  return `${parsed.kind}:${titleKey(parsed.title)}:${parsed.year ?? ''}`;
}

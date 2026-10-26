// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Quality parsed from a search result's title, how watchable it is, and the ranking of
// results. A port of torrentplayer-search's quality.rs and rank.rs: pure functions, shared by
// the main process (ranking) and the renderer (labels).

export const AUDIO_LABELS = {
  web: 'AAC/Opus',
  dd: 'Dolby Digital',
  ddp: 'Dolby Digital Plus',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
};

/** Smallest plausible size for real 2160p video. */
export const MIN_UHD_BYTES = 600 * 1024 * 1024;
/** An unmarked result smaller than this is probably not a video. */
export const MIN_UNMARKED_VIDEO_BYTES = 100 * 1024 * 1024;

class Words {
  constructor(title) {
    const lower = title.toLowerCase().replaceAll('hdr10+', 'hdr10plus ');
    this.list = lower.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  }
  has(word) {
    return this.list.includes(word);
  }
  any(words) {
    return this.list.some((w) => words.includes(w));
  }
  pair(a, b) {
    for (let i = 0; i + 1 < this.list.length; i++) {
      if (this.list[i] === a && this.list[i + 1] === b) return true;
    }
    return false;
  }
  triple(a, b, c) {
    for (let i = 0; i + 2 < this.list.length; i++) {
      if (this.list[i] === a && this.list[i + 1] === b && this.list[i + 2] === c) return true;
    }
    return false;
  }
  yts() {
    return this.has('yts') || this.has('yify');
  }
}

const isYear = (w) => /^(19|20)\d\d$/.test(w);
const isDigits = (s) => s.length > 0 && /^\d+$/.test(s);

function resolution(words) {
  if (words.any(['2160p', '4k', 'uhd', '3840x2160', '4096x2160'])) return '2160p';
  if (words.any(['1080p', '1080i', '1920x1080', 'fhd'])) return '1080p';
  if (words.any(['720p', '1280x720'])) return '720p';
  if (words.any(['480p', '576p', '360p', 'sd', 'dvdrip'])) return '480p';
  return null;
}

function codec(words) {
  if (words.any(['x265', 'h265', 'hevc']) || words.pair('h', '265')) return 'x265';
  if (words.has('av1')) return 'AV1';
  if (words.has('vp9')) return 'VP9';
  if (words.any(['x264', 'h264', 'avc']) || words.pair('h', '264') || words.yts()) return 'x264';
  if (words.any(['xvid', 'divx'])) return 'Xvid';
  return null;
}

const CAM_WORDS = [
  'camrip', 'hdcam', 'hqcam', 'telesync', 'hdts', 'hdtc', 'telecine', 'screener', 'dvdscr',
  'bdscr', 'webscreener', 'predvd',
];

function source(words, releaseLike) {
  const cam =
    words.any(CAM_WORDS) ||
    (releaseLike &&
      words.list.some(
        (w, i) => w === 'cam' || w === 'tc' || w === 'scr' || (w === 'ts' && i + 1 < words.list.length),
      ));
  if (cam) return 'CAM';
  if (words.any(['bluray', 'bdrip', 'brrip', 'bdremux', 'remux']) || words.pair('blu', 'ray')) return 'BluRay';
  if (words.has('webdl') || words.pair('web', 'dl')) return 'WEB-DL';
  if (words.has('webrip') || words.pair('web', 'rip')) return 'WEBRip';
  if (words.has('web')) return 'WEB-DL';
  if (words.any(['hdtv', 'pdtv'])) return 'HDTV';
  if (words.any(['dvdrip', 'dvd', 'dvd5', 'dvd9'])) return 'DVD';
  return null;
}

function container(words) {
  if (words.any(['mp4', 'm4v']) || words.yts()) return 'MP4';
  if (words.has('webm')) return 'WebM';
  if (words.has('mkv')) return 'MKV';
  if (words.any(['avi', 'wmv', 'flv', 'm2ts', 'mpg', 'mpeg']) || words.list.at(-1) === 'ts') return 'AVI/TS';
  return null;
}

function audio(words, lower, releaseLike) {
  const stem = (name) => words.list.some((w) => w.startsWith(name) && isDigits(w.slice(name.length)));
  let ddPlus = false;
  let at = lower.indexOf('dd+');
  while (at >= 0) {
    const before = at > 0 ? lower[at - 1] : '';
    if (!/[\p{L}\p{N}]/u.test(before)) ddPlus = true;
    at = lower.indexOf('dd+', at + 1);
  }
  if (stem('aac') || words.any(['opus', 'mp3', 'flac', 'vorbis'])) return 'web';
  if (words.has('truehd') || words.pair('true', 'hd')) return 'truehd';
  if (stem('dts') || words.any(['dtshd', 'dtsx', 'dtsma', 'dtses'])) return 'dts';
  if (
    ddPlus || stem('ddp') || words.any(['eac3', 'atmos']) || words.triple('e', 'ac', '3') ||
    words.triple('dolby', 'digital', 'plus')
  ) return 'ddp';
  if (
    words.list.some((w) => w.startsWith('dd') && isDigits(w.slice(2))) ||
    (releaseLike && words.has('dd')) || words.has('ac3') || words.pair('ac', '3') || words.pair('dolby', 'digital')
  ) return 'dd';
  return null;
}

function audioOnly(words) {
  return (
    words.any(['mp3', 'flac', 'm4b', 'm4a', 'wav', 'alac', 'kbps', 'audiobook', 'audiobooks', 'аудиокнига', 'аудиокниги']) ||
    words.pair('audio', 'book') ||
    words.list.some((w) => w.endsWith('kbps') && isDigits(w.slice(0, -4)))
  );
}

function ebook(words) {
  return words.any(['pdf', 'epub', 'mobi', 'djvu', 'azw3', 'chm', 'ebook', 'ebooks']) || words.pair('e', 'book');
}

function categoryKind(category) {
  const c = category.toLowerCase();
  if (/movie|tv|video|anime|film|series/.test(c)) return 'video';
  if (/audio|music|podcast/.test(c)) return 'audio';
  if (/book|pc|game|software|app|console|xxx|other/.test(c)) return 'notVideo';
  return null;
}

/** The content kind Torznab category ids imply: 2000s and 5000s are video. */
export function kindOfCategoryIds(ids) {
  let kind = null;
  for (const id of ids) {
    const top = Math.floor(id / 1000);
    if (top === 2 || top === 5) return 'video';
    if (top === 1 || top === 3 || top === 4 || top === 7) kind = 'notVideo';
  }
  return kind;
}

/**
 * Parses the quality a title claims. Returns the QualityDto shape the UI shows, plus the
 * fields ranking needs. With `audioConverts` (FFmpeg is there), Dolby and DTS audio count as
 * playable: the player converts them as the video plays.
 */
export function parseQuality(title, category, size, categoryIdKind = null, { audioConverts = false } = {}) {
  const words = new Words(title);
  const res = resolution(words);
  const cod = codec(words);
  const hdr =
    words.any(['hdr', 'hdr10', 'hdr10plus', 'dovi', 'dolbyvision']) || words.pair('dolby', 'vision') ||
    (res === '2160p' && words.has('dv'));
  const releaseLike = res !== null || cod !== null || words.list.some(isYear);
  const src = source(words, releaseLike);
  const cont = container(words);
  const aud = audio(words, title.toLowerCase(), releaseLike);
  const suspectSize = res === '2160p' && typeof size === 'number' && size < MIN_UHD_BYTES;
  const videoMarkers = res !== null || cod !== null || src !== null;
  const unmarked = !videoMarkers && cont === null;
  const catKind = categoryIdKind ?? (category ? categoryKind(category) : null);
  let kind;
  if (unmarked && audioOnly(words)) kind = 'audio';
  else if (unmarked && ebook(words)) kind = 'notVideo';
  else if (catKind === 'video') kind = 'video';
  else if ((catKind === 'audio' || catKind === 'notVideo') && !videoMarkers) kind = catKind;
  else if (videoMarkers || cont !== null) kind = 'video';
  else kind = 'unknown';

  const camera = src === 'CAM';
  const silentAudio = aud !== null && aud !== 'web' && !audioConverts ? aud : null;
  let playable;
  if (cont === 'AVI/TS' || cod === 'Xvid') playable = 'needsFullPlayer';
  else if (silentAudio) playable = 'unlikely';
  else if ((cont === 'MP4' || cont === 'WebM') && cod === 'x265') playable = 'likely';
  else if (cont === 'MP4' || cont === 'WebM') playable = 'plays';
  else if (cod === 'x265') playable = 'unlikely';
  else if (cod !== null || cont === 'MKV') playable = 'likely';
  else playable = 'unknown';

  const labelParts = [];
  if (res) labelParts.push(res);
  if (hdr) labelParts.push('HDR');
  if (src) labelParts.push(src);

  return {
    resolution: res,
    hdr,
    codec: cod,
    source: src,
    container: cont,
    camera,
    suspectSize,
    playable,
    label: labelParts.join(' '),
    kind,
    audio: aud ? AUDIO_LABELS[aud] : null,
    audioPlays: aud ? aud === 'web' || audioConverts : null,
  };
}

/** How good a result is to watch now: seeders, quality, and playability. */
export function watchScore(seeders, peers, q) {
  const s = seeders ?? 0;
  let leechers = 0;
  if (typeof peers === 'number') leechers = typeof seeders === 'number' && peers >= seeders ? peers - seeders : peers;
  let score = 8 * Math.log1p(s);
  if (s > 0) score += (4 * s) / (s + leechers);
  if (seeders === 0) score -= 40;
  else if (seeders === 1 || seeders === 2) score -= 12;
  else if (seeders === null || seeders === undefined) score -= 15;
  if (q.suspectSize) score -= 20;
  else if (q.resolution === '2160p') score += s < 10 ? 20 : 28;
  else if (q.resolution === '1080p') score += 26;
  else if (q.resolution === '720p') score += 16;
  else if (q.resolution === '480p') score += 6;
  else score += 12;
  score += { BluRay: 6, 'WEB-DL': 6, WEBRip: 4, HDTV: 2, DVD: 1, CAM: -60 }[q.source] ?? 0;
  if (q.hdr) score += 2;
  score += { plays: 10, likely: 3, unknown: 0, unlikely: -3, needsFullPlayer: -10 }[q.playable] ?? 0;
  if (q.audio) score += q.audioPlays ? 2 : -10;
  if (q.kind === 'notVideo') score -= 25;
  return score;
}

/** Why a result ranks where it does, for example `1080p · 412 seeders · plays in built-in player`. */
export function reason(seeders, q) {
  const parts = [];
  if (q.camera) parts.push('camera copy (low quality)');
  else if (q.label) parts.push(q.label);
  if (seeders === null || seeders === undefined) parts.push('seeders unknown');
  else if (seeders === 0) parts.push('no seeders');
  else if (seeders === 1) parts.push('1 seeder');
  else parts.push(`${seeders} seeders`);
  if (q.playable === 'needsFullPlayer') parts.push('needs the full player');
  else if (q.audio && q.audioPlays === false) parts.push(`${q.audio} audio: no sound in built-in player`);
  else if (q.playable === 'plays') parts.push('plays in built-in player');
  else if (q.playable === 'unlikely') parts.push('may need the full player');
  if (q.suspectSize) parts.push('too small to be real 4K');
  if (q.kind === 'notVideo') parts.push('nothing to play');
  else if (q.kind === 'audio') parts.push('audio');
  return parts.join(' · ');
}

/** Whether a result may be the best pick: seeded, not a camera copy, playable, a video. */
export function pickable(r) {
  const q = r.quality;
  let video;
  if (q.kind === 'video' || q.kind === 'audio') video = true;
  else if (q.kind === 'notVideo') video = false;
  else video = r.sizeBytes === null || r.sizeBytes === undefined || r.sizeBytes >= MIN_UNMARKED_VIDEO_BYTES;
  return (
    typeof r.seeders === 'number' && r.seeders > 0 && !q.camera && !q.suspectSize && video &&
    q.playable !== 'needsFullPlayer'
  );
}

/** Lowercase search tokens; `6.006` stays one token. */
export function tokens(text) {
  const chars = [...text.toLowerCase()];
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const digitDot = c === '.' && i > 0 && /\d/.test(chars[i - 1]) && i + 1 < chars.length && /\d/.test(chars[i + 1]);
    if (/[\p{L}\p{N}]/u.test(c) || digitDot) cur += c;
    else if (cur) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Sorts results: every query word matched first, then most matched, then the watch score,
 * seeders, peers. Marks one best pick and moves it first. Returns the new order.
 */
export function rank(results, query) {
  const wanted = tokens(query);
  const relevance = (title) => {
    if (wanted.length === 0) return [true, 0];
    const have = new Set(tokens(title));
    const matched = wanted.filter((w) => have.has(w)).length;
    return [matched === wanted.length, matched];
  };
  const keyed = results.map((r) => {
    const [all, matched] = relevance(r.title);
    return { r, all, matched };
  });
  keyed.sort((a, b) => {
    if (a.all !== b.all) return a.all ? -1 : 1;
    if (a.matched !== b.matched) return b.matched - a.matched;
    if (a.r.watchScore !== b.r.watchScore) return b.r.watchScore - a.r.watchScore;
    const as = a.r.seeders ?? -1;
    const bs = b.r.seeders ?? -1;
    if (as !== bs) return bs - as;
    return (b.r.peers ?? -1) - (a.r.peers ?? -1);
  });
  const sorted = keyed.map((k) => k.r);
  for (const r of sorted) r.bestPick = false;
  let best = -1;
  for (let i = 0; i < keyed.length; i++) {
    if (!keyed[i].all) break;
    if (pickable(keyed[i].r)) {
      best = i;
      break;
    }
  }
  if (best >= 0) {
    const [pick] = sorted.splice(best, 1);
    pick.bestPick = true;
    sorted.unshift(pick);
  }
  return sorted;
}

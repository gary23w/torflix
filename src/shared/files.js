// SPDX-License-Identifier: MIT OR Apache-2.0
// File kinds, natural ordering, and which file of a torrent to play. Pure functions.

const VIDEO = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'ogv', '3gp']);
const AUDIO = new Set(['mp3', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'oga', 'opus', 'wav', 'wma', 'ape', 'aif', 'aiff', 'mka', 'alac']);
const SUBTITLE = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub', 'idx', 'sup']);
const DOCUMENT = new Set(['txt', 'nfo', 'md', 'pdf', 'epub', 'html', 'htm', 'rtf', 'doc', 'docx']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

/** Video containers and audio formats a Chromium `<video>` cannot play. */
const NEEDS_FULL_PLAYER = new Set(['ogv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'wma', 'ape', 'aif', 'aiff', 'mka', '3gp']);

export function fileName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export function extensionOf(path) {
  const name = fileName(path).toLowerCase();
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1);
}

export function fileKind(path) {
  const ext = extensionOf(path);
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (SUBTITLE.has(ext)) return 'subtitle';
  if (DOCUMENT.has(ext)) return 'document';
  return 'other';
}

export function isImage(path) {
  return IMAGE.has(extensionOf(path));
}

export function folderOf(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export function isPlayable(file) {
  return file.kind === 'video' || file.kind === 'audio';
}

export function playableInWebview(path) {
  return !NEEDS_FULL_PLAYER.has(extensionOf(path));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural order: "Lecture 2" before "Lecture 10". */
export function naturalCompare(a, b) {
  return collator.compare(a, b);
}

/** Playable files first, then the rest; each in natural path order. */
export function sortFiles(files) {
  return [...files].sort((a, b) => {
    const av = isPlayable(a) ? 0 : 1;
    const bv = isPlayable(b) ? 0 : 1;
    return av - bv || naturalCompare(a.path, b.path);
  });
}

/** Sample files and extras ("sample", "trailer") that should not be the main video. */
export function isExtra(path) {
  const name = fileName(path).toLowerCase();
  return /(^|[^a-z])(sample|trailer|preview)([^a-z]|$)/.test(name) || /^rarbg/.test(name);
}

/** What to call a torrent's playable files. */
export function mediaNoun(files, count) {
  const playable = files.filter(isPlayable);
  const audio = playable.length > 0 && playable.every((f) => f.kind === 'audio');
  const noun = audio ? 'track' : 'video';
  return count === 1 ? noun : `${noun}s`;
}

/**
 * The playable files of a torrent in lecture order: natural sort, samples and trailers last.
 * A torrent with several is a "course" in the queue.
 */
export function lectureOrder(files) {
  return files
    .filter((f) => isPlayable(f))
    .sort((a, b) => {
      const ae = isExtra(a.path) ? 1 : 0;
      const be = isExtra(b.path) ? 1 : 0;
      return ae - be || naturalCompare(a.path, b.path);
    });
}

/**
 * The file Play starts: the largest playable video, else an album's first track. Null when
 * nothing plays.
 */
export function playTarget(files, preferred = null) {
  const chosen = files.find((f) => f.index === preferred);
  if (chosen) return chosen;
  const largest = (list) => list.reduce((best, f) => (best && best.length >= f.length ? best : f), null);
  const videos = files.filter((f) => f.kind === 'video' && !isExtra(f.path));
  const anyVideos = videos.length > 0 ? videos : files.filter((f) => f.kind === 'video');
  if (anyVideos.length === 0) {
    const tracks = files.filter((f) => f.kind === 'audio').sort((a, b) => naturalCompare(a.path, b.path));
    return tracks.find((f) => playableInWebview(f.path)) ?? tracks[0] ?? null;
  }
  return largest(anyVideos.filter((f) => playableInWebview(f.path))) ?? largest(anyVideos);
}

export function isTorrentFile(name) {
  return name.toLowerCase().endsWith('.torrent');
}

/** Whether text is a magnet link or an http(s) link to a .torrent file. */
export function looksLikeLink(text) {
  const t = text.trim();
  return /^magnet:\?/i.test(t) || /^https?:\/\/\S+$/i.test(t);
}

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', ogv: 'video/ogg', mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac',
  m4a: 'audio/mp4', m4b: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  srt: 'text/plain', vtt: 'text/vtt', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
};

export function mimeOf(path) {
  return MIME[extensionOf(path)] ?? 'application/octet-stream';
}

// SPDX-License-Identifier: MIT OR Apache-2.0
// Subtitle parsing (SRT, WebVTT, ASS/SSA) into plain-text cues, and matching subtitle files to
// a video. Pure functions; nothing here touches the DOM or the network.

/** Most cues kept from one file. */
export const MAX_CUES = 20_000;
export const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

const LANGUAGES = {
  en: 'English', eng: 'English', english: 'English', es: 'Spanish', spa: 'Spanish', spanish: 'Spanish',
  fr: 'French', fre: 'French', fra: 'French', french: 'French', de: 'German', ger: 'German', deu: 'German',
  german: 'German', it: 'Italian', ita: 'Italian', italian: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  portuguese: 'Portuguese', ptbr: 'Portuguese (Brazil)', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', dutch: 'Dutch',
  ru: 'Russian', rus: 'Russian', russian: 'Russian', ja: 'Japanese', jpn: 'Japanese', japanese: 'Japanese',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', chinese: 'Chinese', ko: 'Korean', kor: 'Korean', korean: 'Korean',
  ar: 'Arabic', ara: 'Arabic', arabic: 'Arabic', pl: 'Polish', pol: 'Polish', polish: 'Polish', tr: 'Turkish',
  tur: 'Turkish', turkish: 'Turkish', sv: 'Swedish', swe: 'Swedish', swedish: 'Swedish', da: 'Danish',
  dan: 'Danish', danish: 'Danish', fi: 'Finnish', fin: 'Finnish', finnish: 'Finnish', no: 'Norwegian',
  nor: 'Norwegian', norwegian: 'Norwegian', cs: 'Czech', cze: 'Czech', ces: 'Czech', czech: 'Czech',
  hu: 'Hungarian', hun: 'Hungarian', hungarian: 'Hungarian', el: 'Greek', gre: 'Greek', ell: 'Greek',
  greek: 'Greek', he: 'Hebrew', heb: 'Hebrew', hebrew: 'Hebrew', hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
  id: 'Indonesian', ind: 'Indonesian', indonesian: 'Indonesian', th: 'Thai', tha: 'Thai', thai: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese', vietnamese: 'Vietnamese', uk: 'Ukrainian', ukr: 'Ukrainian',
  ukrainian: 'Ukrainian', ro: 'Romanian', rum: 'Romanian', ron: 'Romanian', romanian: 'Romanian',
};
const TAGS = {
  English: 'en', Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt',
  'Portuguese (Brazil)': 'pt-BR', Dutch: 'nl', Russian: 'ru', Japanese: 'ja', Chinese: 'zh', Korean: 'ko',
  Arabic: 'ar', Polish: 'pl', Turkish: 'tr', Swedish: 'sv', Danish: 'da', Finnish: 'fi', Norwegian: 'no',
  Czech: 'cs', Hungarian: 'hu', Greek: 'el', Hebrew: 'he', Hindi: 'hi', Indonesian: 'id', Thai: 'th',
  Vietnamese: 'vi', Ukrainian: 'uk', Romanian: 'ro',
};

const stem = (name) => name.replace(/\.[^.]+$/, '');
const base = (path) => path.split('/').pop() ?? path;
const split = (s) => s.split(/[._\-\s[\]()]+/).filter(Boolean);

/**
 * Describes a subtitle file in a torrent relative to a video: its language from the file name,
 * whether it belongs to the video, and its flags.
 */
export function describeSubtitle(file, videoPath, videoCount = 1) {
  const name = base(file.path);
  const videoStem = stem(base(videoPath)).toLowerCase();
  const subStem = stem(name).toLowerCase();
  const parts = split(subStem);
  const videoParts = new Set(split(videoStem));
  let language = null;
  let languageName = null;
  const forced = parts.includes('forced');
  const sdh = parts.includes('sdh') || parts.includes('cc') || (parts.includes('hi') && parts.length > 1);
  // The language is usually named by a trailing part that is not part of the video's own name.
  for (let i = parts.length - 1; i >= 0 && i >= parts.length - 4; i--) {
    const p = parts[i];
    if (videoParts.has(p)) continue;
    if (LANGUAGES[p]) {
      languageName = LANGUAGES[p];
      language = TAGS[languageName] ?? null;
      break;
    }
  }
  // The folder may name the language too (Subs/English/2_English.srt).
  if (!languageName) {
    const folders = file.path.toLowerCase().split('/').slice(0, -1);
    for (const f of folders.reverse()) {
      if (LANGUAGES[f]) {
        languageName = LANGUAGES[f];
        language = TAGS[languageName] ?? null;
        break;
      }
    }
  }
  const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')).toLowerCase() : '';
  const inSubsFolder = /(^|\/)(subs?|subtitles?)(\/|$)/.test(folder);
  const shared = parts.filter((p) => videoParts.has(p)).length;
  const matched =
    subStem === videoStem ||
    subStem.startsWith(videoStem) ||
    (videoParts.size > 0 && shared >= Math.min(3, videoParts.size)) ||
    (inSubsFolder && videoCount <= 1);
  let label;
  if (languageName) {
    const flags = [];
    if (forced) flags.push('forced');
    if (sdh) flags.push('SDH');
    label = flags.length ? `${languageName} (${flags.join(', ')})` : languageName;
  } else label = name;
  return { fileIndex: file.index, label, language, fileName: name, matched, forced, sdh, length: file.length };
}

function timeToMs(h, m, s, frac) {
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const VTT_TIME = /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/;

function stripTags(text) {
  return text
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseSrtLike(text, format) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  let truncated = false;
  for (const block of blocks) {
    const lines = block.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) i++;
    if (i >= lines.length) continue;
    const m = format === 'webvtt' ? VTT_TIME.exec(lines[i]) : SRT_TIME.exec(lines[i]);
    if (!m) continue;
    let startMs;
    let endMs;
    if (format === 'webvtt') {
      startMs = timeToMs(m[1] ?? 0, m[2], m[3], m[4]);
      endMs = timeToMs(m[5] ?? 0, m[6], m[7], m[8]);
    } else {
      startMs = timeToMs(m[1], m[2], m[3], m[4]);
      endMs = timeToMs(m[5], m[6], m[7], m[8]);
    }
    const body = stripTags(lines.slice(i + 1).join('\n'));
    if (!body || endMs <= startMs) continue;
    if (cues.length >= MAX_CUES) {
      truncated = true;
      break;
    }
    cues.push({ startMs, endMs, text: body });
  }
  return { format, cues, truncated };
}

function parseAss(text) {
  const cues = [];
  let truncated = false;
  let fields = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('Format:')) {
      fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!line.startsWith('Dialogue:') || !fields) continue;
    const values = line.slice(9).split(',');
    const textAt = fields.indexOf('text');
    const startAt = fields.indexOf('start');
    const endAt = fields.indexOf('end');
    if (textAt < 0 || startAt < 0 || endAt < 0) continue;
    const parse = (t) => {
      const m = /(\d+):(\d{2}):(\d{2})[.:](\d{2})/.exec(t.trim());
      return m ? timeToMs(m[1], m[2], m[3], `${m[4]}0`) : null;
    };
    const startMs = parse(values[startAt] ?? '');
    const endMs = parse(values[endAt] ?? '');
    const body = stripTags(values.slice(textAt).join(',').replace(/\\N|\\n/g, '\n'));
    if (startMs === null || endMs === null || !body || endMs <= startMs) continue;
    if (cues.length >= MAX_CUES) {
      truncated = true;
      break;
    }
    cues.push({ startMs, endMs, text: body });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return { format: 'ass', cues, truncated };
}

/** Parses subtitle text by its content (and the file name as a hint). */
export function parseSubtitles(text, name = '') {
  const clean = text.replace(/^﻿/, '');
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (/^WEBVTT/.test(clean) || ext === 'vtt') return parseSrtLike(clean, 'webvtt');
  if (/^\[Script Info\]/im.test(clean) || ext === 'ass' || ext === 'ssa') return parseAss(clean);
  return parseSrtLike(clean, 'srt');
}

/** Escapes plain text for a `VTTCue`, whose text is parsed as cue markup. */
export function cueText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Cues as an SRT file, for a player that loads subtitles itself (the TV's player on Android).
 * Its SRT reader understands a little HTML, so the text is escaped as for a `VTTCue`.
 */
export function cuesToSrt(cues) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = (ms) => {
    const t = Math.max(0, Math.round(ms));
    return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${cueText(c.text)}\n`).join('\n');
}

/** Decodes subtitle bytes: UTF-8, or Windows-1252 when the bytes are not valid UTF-8. */
export function decodeSubtitleBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
}

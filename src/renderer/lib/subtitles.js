// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Subtitles in the player: the CC menu's entries, which track to show, and adding cues to a
// text track. Cues arrive as plain text and go through `VTTCue`, never through HTML.

import { cueText } from '../../shared/subtitles.js';

export { cueText, cuesToSrt } from '../../shared/subtitles.js';

export const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
export const SUBTITLE_ACCEPT = '.srt,.vtt,.ass,.ssa';

/** The CC menu's entries: the video's own files, loaded files, other files in the torrent. */
export function subtitleOptions(list, locals) {
  const files = (list?.files ?? []).map((f) => {
    const tooLarge = f.length > MAX_SUBTITLE_BYTES;
    return {
      id: `file:${f.fileIndex}`,
      label: f.label,
      detail: tooLarge ? 'too large to load' : f.label === f.fileName ? null : f.fileName,
      language: f.language ?? '',
      group: f.matched ? 'video' : 'other',
      enabled: !tooLarge,
      forced: f.forced,
    };
  });
  const loaded = locals.map((l) => ({ id: l.id, label: l.name, detail: 'from this computer', language: '', group: 'local', enabled: true, forced: false }));
  return [...files.filter((o) => o.group === 'video'), ...loaded, ...files.filter((o) => o.group === 'other')];
}

export function subtitleGroups(options) {
  const of = (...gs) => options.filter((o) => gs.includes(o.group));
  return [
    { title: null, options: of('video', 'local') },
    { title: 'Other subtitles in this torrent', options: of('other') },
  ].filter((g) => g.options.length > 0);
}

let memory = null;

export function rememberSubtitle(option) {
  memory = option === null ? { on: false } : { on: true, language: option.language, label: option.label };
}

export function rememberedSubtitle() {
  return memory;
}

const primary = (tag) => tag.toLowerCase().split('-')[0] ?? '';

function inLanguage(options, language, label) {
  const want = primary(language);
  if (want === '') return label === undefined ? undefined : options.find((o) => o.label === label);
  const same = options.filter((o) => primary(o.language) === want);
  return same.find((o) => o.label === label) ?? same.find((o) => !o.forced) ?? same[0];
}

/** The option to show when a video starts, or null. */
export function initialSubtitle(options, remembered, byDefault, languages) {
  const usable = options.filter((o) => o.enabled && (o.group === 'video' || o.group === 'local'));
  if (remembered !== null) {
    if (!remembered.on) return null;
    const same = inLanguage(usable, remembered.language, remembered.label);
    if (same) return same.id;
  }
  if (!byDefault) return null;
  for (const language of languages) {
    const found = inLanguage(usable, language);
    if (found) return found.id;
  }
  return null;
}

/** What the C key switches to. */
export function toggledSubtitle(options, current, last, languages) {
  if (current !== null) return null;
  const enabled = options.filter((o) => o.enabled);
  if (last !== null && enabled.some((o) => o.id === last)) return last;
  const remembered = rememberedSubtitle();
  return (
    initialSubtitle(options, remembered?.on ? remembered : null, true, languages) ??
    enabled.find((o) => o.group === 'video' || o.group === 'local')?.id ??
    enabled[0]?.id ??
    null
  );
}

/**
 * Adds cues to a text track. Each keeps its plain text as `plainText`, which the player's own
 * subtitle layer shows (as text, never as markup).
 */
export function addCues(track, cues) {
  for (const cue of cues) {
    const c = new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cueText(cue.text));
    c.plainText = cue.text;
    track.addCue(c);
  }
  return cues.length;
}

export function checkSubtitleFile(file) {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!SUBTITLE_ACCEPT.split(',').includes(`.${ext}`)) return 'Choose an SRT, WebVTT, ASS, or SSA subtitle file.';
  if (file.size > MAX_SUBTITLE_BYTES) return 'That subtitle file is larger than 5 MiB.';
  return null;
}

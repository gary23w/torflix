// SPDX-License-Identifier: MIT OR Apache-2.0
//
// FFmpeg, if the user has it: Torflix uses it to convert audio the built-in player cannot
// decode (Dolby Digital, Dolby Digital Plus, Dolby TrueHD, DTS) to AAC while the video plays,
// so those videos have sound. FFmpeg is optional and never downloaded by Torflix: it is found
// in the folder chosen in Settings, on PATH, or (Windows) where winget links it.

import { spawn } from 'node:child_process';
import path from 'node:path';

/** The probe runs once the video has opened, so its bytes are there; the margin is for the end of a Matroska file. */
const PROBE_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;

/** Audio codecs Chromium (and so the built-in player) decodes itself. */
const DECODES = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'pcm_mulaw', 'pcm_alaw']);

const CODEC_NAMES = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  truehd: 'Dolby TrueHD',
  mlp: 'Dolby TrueHD',
  dts: 'DTS',
  alac: 'ALAC',
  mp2: 'MP2',
};

const LANGUAGES = { eng: 'English', jpn: 'Japanese', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', hin: 'Hindi', ara: 'Arabic', dut: 'Dutch', nld: 'Dutch', pol: 'Polish', tur: 'Turkish', swe: 'Swedish' };
const TAG = { eng: 'en', jpn: 'ja', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru', kor: 'ko', chi: 'zh', zho: 'zh', hin: 'hi', ara: 'ar', dut: 'nl', nld: 'nl', pol: 'pl', tur: 'tr', swe: 'sv' };

export const codecName = (codec) => CODEC_NAMES[codec] ?? (codec ? codec.toUpperCase() : 'unknown');
export const decodes = (codec) => DECODES.has(codec) || /^pcm_/.test(codec ?? '');

/** Runs a command and collects its output, or rejects after `timeout`. */
function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeout);
    child.stdout.on('data', (d) => {
      if (out.length < 1_000_000) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 20_000) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `${path.basename(cmd)} exited with ${code}`));
    });
  });
}

/**
 * Chooses which audio track to play: one in the viewer's language, else the one marked
 * default, else the first. `languages` are BCP 47 tags (`navigator.languages`).
 */
export function chooseTrack(tracks, languages = []) {
  if (tracks.length === 0) return null;
  for (const lang of languages) {
    const want = String(lang).toLowerCase().split('-')[0];
    const found = tracks.find((t) => t.language === want);
    if (found) return found.n;
  }
  return (tracks.find((t) => t.default) ?? tracks[0]).n;
}

/** Normalizes ffprobe's audio streams. */
export function audioTracks(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  return streams.map((s, n) => {
    const codec = typeof s.codec_name === 'string' ? s.codec_name : null;
    const lang3 = typeof s.tags?.language === 'string' ? s.tags.language.toLowerCase() : null;
    const language = lang3 ? (TAG[lang3] ?? (lang3.length === 2 ? lang3 : null)) : null;
    const channels = Number.isInteger(s.channels) ? s.channels : null;
    const layout = channels === 6 ? '5.1' : channels === 8 ? '7.1' : channels === 2 ? 'stereo' : channels === 1 ? 'mono' : channels ? `${channels} ch` : null;
    const title = typeof s.tags?.title === 'string' ? s.tags.title.slice(0, 80) : null;
    const label = [codecName(codec), layout, lang3 ? (LANGUAGES[lang3] ?? lang3) : null].filter(Boolean).join(' · ');
    return { n, codec, codecLabel: codecName(codec), channels, language, title, default: s.disposition?.default === 1, decodes: decodes(codec), label };
  });
}

export class MediaTools {
  constructor({ settings }) {
    this.settings = settings;
    this.found = null;
    this.finding = null;
    settings.on('change', (next, prev) => {
      if (next.advanced.ffmpegDir !== prev.advanced.ffmpegDir) {
        this.found = null;
        this.finding = null;
        this.tools().then((t) => this.onChange?.(t)).catch(() => {});
      }
    });
  }

  /** `{ ffmpeg, ffprobe, version, dir }`: paths of the tools that work, or null. */
  tools() {
    if (this.found) return Promise.resolve(this.found);
    this.finding ??= this.#find().then((t) => (this.found = t));
    return this.finding;
  }

  async #find() {
    const dir = this.settings.settings.advanced.ffmpegDir;
    const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
    const candidates = (name) => {
      const list = [];
      if (dir) list.push(path.join(dir, exe(name)), path.join(dir, 'bin', exe(name)));
      list.push(exe(name));
      if (process.platform === 'win32' && process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe(name)));
      return list;
    };
    const first = async (name) => {
      for (const c of candidates(name)) {
        try {
          const out = await run(c, ['-hide_banner', '-version'], VERSION_TIMEOUT_MS);
          return { path: c, version: /version (\S+)/.exec(out)?.[1] ?? null };
        } catch {
          // try the next one
        }
      }
      return null;
    };
    const [ffmpeg, ffprobe] = await Promise.all([first('ffmpeg'), first('ffprobe')]);
    return { ffmpeg: ffmpeg?.path ?? null, ffprobe: ffprobe?.path ?? null, version: ffmpeg?.version ?? ffprobe?.version ?? null, dir };
  }

  /** The audio tracks of a stream (read through the loopback server), or [] if unknown. */
  async probeAudio(url) {
    const { ffprobe } = await this.tools();
    if (!ffprobe) return null;
    const out = await run(
      ffprobe,
      ['-v', 'error', '-protocol_whitelist', 'http,tcp', '-probesize', '2000000', '-analyzeduration', '1000000', '-select_streams', 'a', '-show_entries', 'stream=index,codec_name,channels:stream_tags=language,title:stream_disposition=default', '-of', 'json', url],
      PROBE_TIMEOUT_MS,
    );
    return audioTracks(JSON.parse(out));
  }

  /**
   * Starts converting audio track `track` of `input` from `start` seconds to AAC (stereo,
   * ADTS) on stdout. The video is not touched; the player plays both together.
   */
  convertAudio({ input, start, track }) {
    const ffmpeg = this.found?.ffmpeg;
    if (!ffmpeg) return null;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'http,tcp', '-ss', start.toFixed(3), '-i', input, '-map', `0:a:${track}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'adts', 'pipe:1'];
    return spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** For Settings → Advanced. */
  async status() {
    const t = await this.tools();
    return { ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, version: t.version, dir: t.dir };
  }
}

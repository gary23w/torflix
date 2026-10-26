// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Settings: the same shape as TorrentPlayer's settings.json (schema version 4), minus the parts
// this Electron build does not implement (SOCKS5, WireGuard, FFmpeg). Loaded once at start-up,
// validated field by field, and saved on every change. Secrets never live here.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { JsonStore } from './store.js';

export const SCHEMA_VERSION = 4;
const SPEED_RANGE = [0.5, 3];
const MAX_RATE_KIB = 1024 * 1024;
const PEER_LIMIT_RANGE = [5, 500];
const MAX_DOWNLOADS = 100;
const SEED_RATIO_RANGE = [0, 100];
const SEED_TIME_RANGE_MINUTES = [0, 525_600];
const CACHE_LIMIT_RANGE_GB = [1, 100_000];
const CLEANUP_RANGE_DAYS = [1, 3650];
const RESULTS_RANGE = [10, 500];
const LISTEN_PORT_MIN = 1024;
const MAX_TEXT = 1024;

export function defaultSettings() {
  return {
    version: SCHEMA_VERSION,
    playback: {
      defaultSpeed: 1,
      autoplayNext: true,
      resumePosition: true,
      optimizeQueue: false,
      keepCourseOrder: true,
      subtitlesByDefault: false,
      switchDeadCopies: true,
      // A title page gets its copy ready to play as it opens (see preloader.js).
      warmUp: true,
    },
    storage: {
      downloadDir: null,
      cacheLimitGb: null,
      cleanupAfterDays: null,
    },
    bandwidth: {
      downloadLimitKib: 0,
      uploadLimitKib: 0,
      // Off unless turned on: only the video being watched downloads, nothing is shared after.
      backgroundDownloads: false,
      seedAfterWatching: false,
      seedRatioTarget: 2,
      seedTimeLimitMinutes: 0,
      peerLimit: 40,
      maxDownloads: 0,
    },
    search: {
      hideAdult: true,
      preloadTopResult: false,
      prefetchResults: false,
      resultsPerSearch: 100,
    },
    network: {
      incomingPeers: { enabled: false, port: 0, upnp: false },
      vpnHintDismissed: false,
      // Share to TVs (share.js): a media server VLC on an Apple TV finds on this network.
      shareOnLan: false,
    },
    browse: {
      enabled: true,
      fetchInfo: true,
      region: 'US',
      // The Torflix metadata service (meta/); empty asks Wikipedia, Wikidata and TVmaze directly.
      metaService: 'https://torflix-meta.vercel.app',
    },
    advanced: {
      debugOverlay: true,
      // Folder with ffmpeg and ffprobe (or its bin folder); null looks on PATH.
      ffmpegDir: null,
    },
  };
}

/** Settings whose change applies only after a restart. */
const RESTART_REQUIRED = new Set(['storage.downloadDir', 'network.incomingPeers.enabled', 'network.incomingPeers.port', 'network.incomingPeers.upnp']);

const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const inRange = (v, [lo, hi]) => isNum(v) && v >= lo && v <= hi;

function checkFolder(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > MAX_TEXT || /[\p{Cc}]/u.test(dir)) {
    return 'Enter a folder path.';
  }
  if (dir.startsWith('\\\\?\\') || dir.startsWith('\\\\.\\')) return 'Device paths are not supported; choose a normal folder.';
  if (!path.isAbsolute(dir)) return 'Enter a full path (for example D:\\Lectures or /home/me/Lectures).';
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return 'The path cannot contain "." or "..".';
  const normal = parts.filter((p) => !/^[A-Za-z]:$/.test(p));
  if (normal.length === 0) return 'Choose a folder, not the root of a drive.';
  return null;
}

/** Field errors for a full settings object, as `{ field, message }`. */
export function problems(s) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });
  if (!inRange(s.playback.defaultSpeed, SPEED_RANGE)) push('playback.defaultSpeed', 'Choose a speed between 0.5× and 3×.');
  for (const key of ['autoplayNext', 'resumePosition', 'optimizeQueue', 'keepCourseOrder', 'subtitlesByDefault', 'switchDeadCopies', 'warmUp']) {
    if (!isBool(s.playback[key])) push(`playback.${key}`, 'On or off.');
  }
  if (s.storage.downloadDir !== null) {
    const m = checkFolder(s.storage.downloadDir);
    if (m) push('storage.downloadDir', m);
  }
  if (s.storage.cacheLimitGb !== null && !(isInt(s.storage.cacheLimitGb) && inRange(s.storage.cacheLimitGb, CACHE_LIMIT_RANGE_GB))) {
    push('storage.cacheLimitGb', 'Choose a limit between 1 GB and 100 000 GB, or unlimited.');
  }
  if (s.storage.cleanupAfterDays !== null && !(isInt(s.storage.cleanupAfterDays) && inRange(s.storage.cleanupAfterDays, CLEANUP_RANGE_DAYS))) {
    push('storage.cleanupAfterDays', 'Choose between 1 and 3650 days, or never.');
  }
  for (const key of ['downloadLimitKib', 'uploadLimitKib']) {
    if (!(isInt(s.bandwidth[key]) && s.bandwidth[key] >= 0 && s.bandwidth[key] <= MAX_RATE_KIB)) push(`bandwidth.${key}`, 'The largest limit is 1 GiB/s.');
  }
  if (!isBool(s.bandwidth.seedAfterWatching)) push('bandwidth.seedAfterWatching', 'On or off.');
  if (!isBool(s.bandwidth.backgroundDownloads)) push('bandwidth.backgroundDownloads', 'On or off.');
  if (!inRange(s.bandwidth.seedRatioTarget, SEED_RATIO_RANGE)) push('bandwidth.seedRatioTarget', 'Choose a ratio between 0 and 100 (0 keeps seeding).');
  if (!(isInt(s.bandwidth.seedTimeLimitMinutes) && inRange(s.bandwidth.seedTimeLimitMinutes, SEED_TIME_RANGE_MINUTES))) {
    push('bandwidth.seedTimeLimitMinutes', 'Choose up to 525600 minutes (one year), or 0 for no time limit.');
  }
  if (!(isInt(s.bandwidth.peerLimit) && inRange(s.bandwidth.peerLimit, PEER_LIMIT_RANGE))) push('bandwidth.peerLimit', 'Choose between 5 and 500 peers.');
  if (!(isInt(s.bandwidth.maxDownloads) && s.bandwidth.maxDownloads >= 0 && s.bandwidth.maxDownloads <= MAX_DOWNLOADS)) {
    push('bandwidth.maxDownloads', 'Choose up to 100 downloads, or 0 for no limit.');
  }
  if (!isBool(s.search.hideAdult)) push('search.hideAdult', 'On or off.');
  if (!isBool(s.search.preloadTopResult)) push('search.preloadTopResult', 'On or off.');
  if (!isBool(s.search.prefetchResults)) push('search.prefetchResults', 'On or off.');
  if (!(isInt(s.search.resultsPerSearch) && inRange(s.search.resultsPerSearch, RESULTS_RANGE))) push('search.resultsPerSearch', 'Choose between 10 and 500 results.');
  const ip = s.network.incomingPeers;
  if (!isBool(ip.enabled)) push('network.incomingPeers.enabled', 'On or off.');
  if (!isBool(ip.upnp)) push('network.incomingPeers.upnp', 'On or off.');
  if (!(isInt(ip.port) && ip.port >= 0 && ip.port <= 65535 && (ip.port === 0 || ip.port >= LISTEN_PORT_MIN))) {
    push('network.incomingPeers.port', 'Choose a port between 1024 and 65535, or 0 for a random one.');
  }
  if (!isBool(s.network.vpnHintDismissed)) push('network.vpnHintDismissed', 'On or off.');
  if (!isBool(s.network.shareOnLan)) push('network.shareOnLan', 'On or off.');
  if (!isBool(s.browse.enabled)) push('browse.enabled', 'On or off.');
  if (!isBool(s.browse.fetchInfo)) push('browse.fetchInfo', 'On or off.');
  if (!(typeof s.browse.region === 'string' && /^[A-Z]{2}$/.test(s.browse.region))) push('browse.region', 'Use a two-letter country code, for example US or GB.');
  if (!(typeof s.browse.metaService === 'string' && (s.browse.metaService === '' || /^(https:\/\/[a-z0-9.-]+|http:\/\/127\.0\.0\.1)(:\d{1,5})?(\/[\w.\-/]*)?$/i.test(s.browse.metaService)) && s.browse.metaService.length <= 200)) {
    push('browse.metaService', 'Enter the address of a Torflix metadata service (https://…), or leave it empty.');
  }
  if (!isBool(s.advanced.debugOverlay)) push('advanced.debugOverlay', 'On or off.');
  if (s.advanced.ffmpegDir !== null) {
    const m = checkFolder(s.advanced.ffmpegDir);
    if (m) push('advanced.ffmpegDir', m);
  }
  return errors;
}

/** Deep-merges `patch` into a copy of `base`, keeping only keys the defaults know. */
function merge(base, patch, template, prefix, changed) {
  const out = { ...base };
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of Object.keys(template)) {
    if (!(key in patch)) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    const t = template[key];
    if (t !== null && typeof t === 'object' && !Array.isArray(t)) {
      out[key] = merge(base[key] ?? {}, patch[key], t, field, changed);
    } else if (patch[key] !== base[key]) {
      out[key] = patch[key];
      changed.push(field);
    }
  }
  return out;
}

/** Fills missing fields from the defaults and drops unknown ones. */
function normalize(raw) {
  const changed = [];
  const merged = merge(defaultSettings(), raw, defaultSettings(), '', changed);
  merged.version = SCHEMA_VERSION;
  return merged;
}

/** Resets invalid fields to their defaults; returns a note per fix. */
function sanitize(s) {
  const fixes = [];
  const d = defaultSettings();
  for (const p of problems(s)) {
    const [section, key, sub] = p.field.split('.');
    if (sub) s[section][key][sub] = d[section][key][sub];
    else s[section][key] = d[section][key];
    fixes.push(`${p.field} was invalid and was reset`);
  }
  return fixes;
}

export class SettingsStore extends EventEmitter {
  /**
   * @param {string} dataDir the app's data folder
   * @param {string} defaultDownloadDir used when none is chosen
   */
  constructor(dataDir, defaultDownloadDir) {
    super();
    this.store = new JsonStore(path.join(dataDir, 'settings.json'), defaultSettings);
    this.defaultDownloadDir = defaultDownloadDir;
    this.settings = normalize(this.store.loadSync());
    this.loadProblems = [...this.store.problems, ...sanitize(this.settings)];
    this.restartRequired = new Set();
    // The folder used this run; a change applies after a restart.
    this.activeDownloadDir = this.settings.storage.downloadDir ?? defaultDownloadDir;
    if (this.loadProblems.length > 0) this.store.save(this.settings);
  }

  /** The settings and what the Settings page needs to explain them. */
  view() {
    return {
      settings: structuredClone(this.settings),
      warnings: [...this.loadProblems, ...this.warnings()],
      restartRequired: [...this.restartRequired],
      defaultDownloadDir: this.defaultDownloadDir,
      activeDownloadDir: this.activeDownloadDir,
    };
  }

  warnings() {
    const w = [];
    const ip = this.settings.network.incomingPeers;
    if (ip.enabled && !this.settings.network.vpnHintDismissed) {
      w.push('Incoming connections expose your address to more peers; use a VPN if that matters to you.');
    }
    return w;
  }

  /**
   * Applies a partial update. Throws `{ fieldErrors }` when a field is invalid; nothing is
   * saved then. Returns the new view.
   */
  update(patch) {
    const changed = [];
    const next = merge(this.settings, patch, defaultSettings(), '', changed);
    next.version = SCHEMA_VERSION;
    const errors = problems(next);
    if (errors.length > 0) {
      const err = new Error('Some settings are invalid.');
      err.fieldErrors = errors;
      throw err;
    }
    const previous = this.settings;
    this.settings = next;
    for (const field of changed) if (RESTART_REQUIRED.has(field)) this.restartRequired.add(field);
    this.loadProblems = [];
    this.store.save(this.settings);
    if (changed.length > 0) this.emit('change', this.settings, previous, changed);
    return this.view();
  }

  flush() {
    return this.store.flush();
  }
}

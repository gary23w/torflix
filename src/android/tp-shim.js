// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Torflix on Android TV: `window.tp` for the page, over the backend's loopback bridge
// (backend.js) instead of Electron IPC. The same commands, errors and events as
// src/preload/preload.cjs: a command is `POST /rpc/<name>` with its arguments as a JSON array,
// events arrive on `/events`, and bytes travel as `{ $bytes }` (bridge.js). The page's cookie
// carries the bridge's token, so nothing here holds a secret.
//
// The app's native side, `window.tpNative`, opens links and plays video in the TV's own player.
// It talks back through `window.__tpNativeEmit(name, payloadJson)`, delivered to `tp.on`
// subscribers like any other event: `tv-back` (the remote's Back key) and `native-player`.
//
// A classic script, loaded before the app's modules.

(() => {
  'use strict';

  const commands = [
    'appInfo',
    'rendererReady',
    'addTorrentLink',
    'addTorrentFile',
    'listTorrents',
    'torrentDetails',
    'removeTorrent',
    'startStream',
    'stopStream',
    'streamStats',
    'reportPlayback',
    'streamSubtitles',
    'loadSubtitles',
    'parseSubtitles',
    'streamAudio',
    'mediaTools',
    'chooseFfmpegDir',
    'searchTorrents',
    'cancelSearch',
    'preloadBest',
    'cancelPreload',
    'preloadStatus',
    'prefetchResults',
    'previewFrame',
    'browseRows',
    'browseVisible',
    'titlePage',
    'titleInfo',
    'titleById',
    'titleCopies',
    'titleEpisode',
    'warmUpTitle',
    'coolDownTitle',
    'lookupRelease',
    'libraryItems',
    'libraryRemove',
    'libraryClear',
    'loadQueue',
    'saveQueue',
    'queueDownloads',
    'queueReadiness',
    'getSettings',
    'updateSettings',
    'chooseDownloadDir',
    'cacheUsage',
    'shareStatus',
    'clearCache',
    'openDownloadDir',
    'openLink',
    'previewFile',
  ];

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(text) {
    const s = atob(text);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function toWire(value) {
    if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
    if (Array.isArray(value)) return value.map(toWire);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
    return value;
  }

  function fromWire(value) {
    if (Array.isArray(value)) return value.map(fromWire);
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '$bytes' && typeof value.$bytes === 'string') return fromBase64(value.$bytes);
      return Object.fromEntries(keys.map((k) => [k, fromWire(value[k])]));
    }
    return value;
  }

  function failure(error) {
    const err = new Error(error?.message ?? 'Something went wrong.');
    err.kind = error?.kind ?? 'internal';
    err.fieldErrors = error?.fieldErrors ?? null;
    return err;
  }

  async function invoke(name, ...args) {
    let r;
    try {
      const res = await fetch(`/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toWire(args)) });
      r = res.ok ? fromWire(await res.json()) : { ok: false, error: { kind: 'bridge', message: `The app's engine refused the request (${res.status}).` } };
    } catch {
      r = { ok: false, error: { kind: 'bridge', message: "The app's engine is not answering." } };
    }
    if (!r || r.ok !== true) throw failure(r?.error);
    return r.value;
  }

  const api = {};
  for (const name of commands) api[name] = (...args) => invoke(name, ...args);

  const native = window.tpNative ?? null;
  // Links open in the TV's browser (if it has one), through the app.
  api.openLink = async (url) => {
    if (!native) return invoke('openLink', url);
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.length > 4096) throw failure({ kind: 'invalid', message: 'Only http(s) links can be opened.' });
    native.openLink(url);
    return true;
  };

  /** Event subscribers by event name; one event stream serves them all. */
  const subscribers = new Map();
  const dispatch = (name, payload) => {
    for (const callback of subscribers.get(name) ?? []) callback(payload);
  };

  /** Subscribes to an event from the backend or the app; returns an unsubscribe function. */
  api.on = (name, callback) => {
    if (!subscribers.has(name)) subscribers.set(name, new Set());
    subscribers.get(name).add(callback);
    return () => subscribers.get(name)?.delete(callback);
  };
  api.platform = 'android-tv';

  const events = new EventSource('/events');
  events.onmessage = (e) => {
    let message;
    try {
      message = fromWire(JSON.parse(e.data));
    } catch {
      return;
    }
    dispatch(message?.name, message?.payload);
  };

  window.__tpNativeEmit = (name, payloadJson) => {
    let payload = null;
    try {
      payload = payloadJson ? JSON.parse(payloadJson) : null;
    } catch {
      return;
    }
    dispatch(String(name), payload);
  };

  Object.defineProperty(window, 'tp', { value: Object.freeze(api), writable: false, configurable: false });
})();

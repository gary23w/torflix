// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The bridge between the sandboxed renderer and the main process: a fixed list of commands
// and one event channel, exposed as `window.tp`. Nothing else of Node or Electron reaches
// the page.

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(name, ...args) {
  const r = await ipcRenderer.invoke(`tp:${name}`, ...args);
  if (!r || r.ok !== true) {
    const err = new Error(r?.error?.message ?? 'Something went wrong.');
    err.kind = r?.error?.kind ?? 'internal';
    err.fieldErrors = r?.error?.fieldErrors ?? null;
    throw err;
  }
  return r.value;
}

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
  'clearCache',
  'openDownloadDir',
  'openLink',
  'previewFile',
];

const api = {};
for (const name of commands) api[name] = (...args) => invoke(name, ...args);

/** Event subscribers by event name; one IPC listener serves them all. */
const subscribers = new Map();
ipcRenderer.on('tp:event', (_event, message) => {
  for (const callback of subscribers.get(message?.name) ?? []) callback(message.payload);
});

/** Subscribes to an event from the main process; returns an unsubscribe function. */
api.on = (name, callback) => {
  if (!subscribers.has(name)) subscribers.set(name, new Set());
  subscribers.get(name).add(callback);
  return () => subscribers.get(name)?.delete(callback);
};

contextBridge.exposeInMainWorld('tp', Object.freeze(api));

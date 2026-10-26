// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The app shell: the navigation rail, the views, and the one video playing. Views are
// reached from the rail or with Back/Forward (Alt+←/→, the mouse's side buttons). The search
// page keeps its results. Leaving the player keeps the stream open; coming back resumes it.

import { h, replace } from './lib/dom.js';
import { Nav } from './lib/nav.js';
import { toast } from './lib/toast.js';
import { formatRate } from '../shared/format.js';
import { fileName, isTorrentFile, lectureOrder, playTarget, isPlayable } from '../shared/files.js';
import * as Q from './lib/queue.js';
import { otherCopies, MAX_SWITCHES, NO_DATA_MS } from '../shared/copies.js';
import { Rail } from './views/rail.js';
import { BrowseView } from './views/browse.js';
import { TitleView } from './views/title.js';
import { parseRelease, titleKey } from '../shared/release.js';
import { SearchView } from './views/search.js';
import { OpenView } from './views/open.js';
import { LibraryView } from './views/library.js';
import { FilesView } from './views/files.js';
import { SettingsView } from './views/settings.js';
import { QueuePanel } from './views/queue-panel.js';
import { Player } from './views/player.js';
import { isTv, startTv } from './lib/tv.js';

const api = window.tp;
/** On Android TV, the TV's own player plays the video (see player.js). */
const native = isTv(api) ? (window.tpNative ?? null) : null;
const DOWNLOADS_POLL_MS = 2000;
const READINESS_POLL_MS = 4000;

const state = {
  settings: null,
  queue: { version: 2, items: [], current: null, order: 'inOrder' },
  torrents: [],
  playing: null,
  downloads: { items: [], link: null },
  busy: new Set(),
};

const nav = new Nav({ view: 'browse' });
const viewsRoot = document.getElementById('views');
const views = {};
for (const name of ['browse', 'title', 'search', 'open', 'library', 'files', 'player', 'settings']) {
  views[name] = h('section.view', { dataset: { view: name }, class: name === 'player' ? 'player-view' : '' });
  viewsRoot.append(views[name]);
}
// The Playing tab holds one video, the one playing: there is no queue to show (the panel's
// bookkeeping of that one item stays, off screen).
const queueRoot = h('aside.queue-panel', { 'aria-label': 'Queue' });
const stage = h('div.stage.idle');
views.player.append(stage);
const bottomBar = h('div.bottom-bar');
document.getElementById('app').append(bottomBar);

const settings = () => state.settings?.settings ?? defaults();
function defaults() {
  return {
    playback: { defaultSpeed: 1, autoplayNext: true, resumePosition: true, optimizeQueue: false, keepCourseOrder: true, subtitlesByDefault: false },
    search: { hideAdult: true, preloadTopResult: true, resultsPerSearch: 100 },
    browse: { enabled: true, fetchInfo: true, region: 'US', metaService: 'https://torflix-meta.vercel.app' },
    advanced: { debugOverlay: true },
  };
}
const onError = (err) => {
  console.error(err);
  toast(err?.message ?? String(err), { kind: 'error', ms: 7000 });
};

// ----- views -----

const rail = new Rail(document.getElementById('rail'), {
  onNavigate: (view) => navigate(view),
  onBack: () => nav.back(),
  onForward: () => nav.forward(),
});

const torrentSpec = (tor) => ({ source: tor.link, infoHash: tor.infoHash, fileIndex: null, title: tor.title, torrentName: tor.title, sizeBytes: tor.sizeBytes });
const searchFor = (query) => {
  nav.go({ view: 'search', searchId: null });
  searchView.search(query);
};
const browseView = new BrowseView(views.browse, {
  api,
  onPlay: (tor) => playSource(torrentSpec(tor)),
  onOpenTitle: (t) => openTitle(t, 'browse'),
  onSearch: searchFor,
  onError,
});

const titleView = new TitleView(views.title, {
  api,
  onPlay: (spec, start) => playSource(spec, start),
  onSearch: searchFor,
  onOpenTitle: (t) => openTitle(t, 'title'),
  browseTitles: () => browseView.allTitles(),
  onError,
});

/** What the page that opened a title knew of it (a Browse title, a search result), by key. */
const titleSeeds = new Map();

/**
 * Opens a title's page. `t` is a Browse title, a search result read as a title, or a related
 * film (`qid`); `from` is the page it was opened from, which the rail keeps lit.
 */
function openTitle(t, from) {
  titleSeeds.set(t.key, t);
  const origin = from === 'title' ? (nav.current.from ?? 'browse') : from;
  nav.go({ view: 'title', key: t.key, kind: t.kind === 'tv' ? 'tv' : 'movie', title: t.title, year: t.year ?? null, qid: t.qid ?? null, from: origin });
}

/** A search result read as a title, to open its page. */
function titleOfResult(r) {
  const parsed = parseRelease(r.title);
  if (!parsed || !titleKey(parsed.title)) return null;
  const kind = parsed.kind === 'tv' || /tv|series|episode/i.test(String(r.category ?? '')) ? 'tv' : 'movie';
  const key = kind === 'tv' ? `tv:${titleKey(parsed.title)}` : `movie:${titleKey(parsed.title)}:${parsed.year ?? ''}`;
  const torrent = { ...r, season: parsed.season, episode: parsed.episode };
  return { key, kind, title: parsed.title, year: parsed.year, seeders: null, torrents: [torrent], best: torrent, meta: null };
}

const searchView = new SearchView(views.search, {
  api,
  settings,
  onPlay: (r) => playSource({ source: r.link, infoHash: r.infoHash, fileIndex: null, title: r.title, torrentName: r.title, sizeBytes: r.sizeBytes }),
  onAdd: (r) => openLink(r.link, { infoHash: r.infoHash }),
  onLink: (link) => openLink(link),
  queuedState: (r) => Q.entryState(state.queue, { infoHash: r.infoHash, source: r.link, fileIndex: null }),
  onSearchStarted: (id) => nav.go({ view: 'search', searchId: id }),
  onOpenTitle: (r) => {
    const t = titleOfResult(r);
    if (t) openTitle(t, 'search');
    else toast('This result does not name a film or series.');
  },
  isBusy: (link, infoHash) => state.busy.has(link) || (infoHash !== null && state.busy.has(infoHash)),
  onError,
});
searchView.onForget = (ids) => nav.forgetSearches(ids);

const openView = new OpenView(views.open, {
  onLink: (link) => openLink(link),
  onFile: (bytes, name) => openFile(bytes, name),
  onShow: (t) => nav.go({ view: 'files', torrentId: t.id }),
});

const libraryView = new LibraryView(views.library, {
  api,
  onPlay: (it) => playSource({ source: it.source, infoHash: it.infoHash, fileIndex: it.fileIndex, title: it.title, torrentName: it.torrentName, sizeBytes: it.sizeBytes }),
  onError,
});

const filesView = new FilesView(views.files, {
  api,
  onPlay: ({ torrent, file }) => {
    const target = file ?? playTarget(torrent.files);
    if (!target) return toast('This torrent has nothing to play.', { kind: 'error' });
    playSource(itemFor(torrent, target));
  },
  onError,
});

const settingsView = new SettingsView(views.settings, {
  api,
  onChanged: (view, message) => {
    state.settings = view;
    queuePanel.renderMenu();
    if (message) toast(message);
  },
  onError,
});

const queuePanel = new QueuePanel(queueRoot, {
  onPlay: (item) => playItem(item),
  onChange: (action, ...args) => changeQueue(action, ...args),
  onCollapse: () => {},
  settings,
  onSettings: (patch) => api.updateSettings(patch).then((v) => settingsView.setView((state.settings = v)) || queuePanel.renderMenu(), onError),
  onMove: (id, delta) => saveQueue(Q.moveItem(state.queue, id, delta)),
  // Playing means a stream is open and has not reached its end.
  isPlaying: () => state.playing !== null && !state.playing.ended,
});

const player = new Player(stage, {
  api,
  settings,
  onEnded: () => onEnded(),
  onNext: () => playNext(),
  onPrev: () => playPrevious(),
  onToggleQueue: () => {},
  onNoData: (info) => {
    const p = state.playing;
    if (!p || p.info.streamId !== info.streamId) return;
    const item = state.queue.items.find((i) => i.id === p.itemId);
    if (item) switchCopy(item, 'nothing arrived');
  },
  onError,
  nextItem: () => Q.nextItem(state.queue),
  native,
  // Back out of the TV's player: back to where Play was pressed; the stream stays open.
  onLeave: () => {
    if (currentView === 'player') nav.back();
  },
});

function itemFor(torrent, file) {
  return { source: torrent.magnet, infoHash: torrent.infoHash, fileIndex: file.index, title: fileName(file.path), torrentName: torrent.name, sizeBytes: file.length };
}

// ----- navigation -----

function navigate(view) {
  if (view === 'search') nav.go({ view: 'search', searchId: searchView.currentId ?? null });
  else if (view === 'files') nav.go({ view: 'files', torrentId: filesView.torrentId ?? null });
  else nav.go({ view });
}

let currentView = null;
nav.on('change', (entry) => showView(entry));

function showView(entry) {
  const leaving = currentView;
  currentView = entry.view;
  for (const [name, el] of Object.entries(views)) el.classList.toggle('active', name === entry.view);
  if (leaving === 'player' && entry.view !== 'player') player.hide();
  if (entry.view === 'player' && leaving !== 'player') player.reveal();
  if (leaving === 'browse' && entry.view !== 'browse') browseView.hide();
  if (entry.view === 'browse') browseView.show();
  if (leaving === 'title') titleView.hide(entry.view);
  if (entry.view === 'title') titleView.show(entry, titleSeeds.get(entry.key) ?? null);
  if (entry.view === 'search') searchView.show(entry.searchId ?? null);
  if (entry.view === 'files') filesView.show(entry.torrentId ?? null);
  if (entry.view === 'library') libraryView.refresh();
  if (entry.view === 'settings') settingsView.refresh();
  if (entry.view === 'open') setTimeout(() => openView.focus(), 0);
  // Not on a TV: there, focusing the box brings up the on-screen keyboard over the page; it
  // waits for OK on the box.
  if (entry.view === 'search' && !entry.searchId && !isTv(api)) setTimeout(() => searchView.focus(), 0);
  bottomBar.classList.toggle('hidden', entry.view === 'player');
  updateRail();
}

function updateRail() {
  rail.update({
    // A title page belongs to the page it was opened from.
    current: currentView === 'title' ? (nav.current.from ?? 'browse') : (currentView ?? 'search'),
    canBack: nav.canBack,
    canForward: nav.canForward,
    hasTorrent: state.torrents.length > 0,
    playing: state.playing !== null,
    upcoming: Q.upcoming(state.queue).length,
  });
}

// ----- torrents -----

async function refreshTorrents() {
  try {
    state.torrents = await api.listTorrents();
  } catch (err) {
    onError(err);
    return;
  }
  openView.setTorrents(state.torrents);
  filesView.setTorrents(state.torrents);
  updateRail();
}

function markBusy(keys, on) {
  for (const k of keys) if (k) on ? state.busy.add(k) : state.busy.delete(k);
  searchView.refreshQueuedStates();
}

async function openLink(link, { infoHash = null, play = false } = {}) {
  markBusy([link, infoHash], true);
  openView.setBusy(true);
  try {
    const t = await api.addTorrentLink(link, infoHash);
    await refreshTorrents();
    openView.setBusy(false);
    afterOpen(t, play);
  } catch (err) {
    openView.setBusy(false, err.message);
    onError(err);
  } finally {
    markBusy([link, infoHash], false);
  }
}

async function openFile(bytes, name = '') {
  openView.setBusy(true);
  try {
    const t = await api.addTorrentFile(bytes);
    await refreshTorrents();
    openView.setBusy(false);
    afterOpen(t, false);
  } catch (err) {
    openView.setBusy(false, err.message);
    onError(err);
  }
}

function afterOpen(t, play) {
  const media = lectureOrder(t.files);
  if (play && media.length > 0) {
    const target = playTarget(t.files);
    return playSource(itemFor(t, target));
  }
  nav.go({ view: 'files', torrentId: t.id });
  if (media.length === 0) toast(`${t.name} has no video or audio files.`);
}

// ----- queue -----

async function saveQueue(queue) {
  if (!queue || queue === state.queue) return;
  state.queue = queue;
  queuePanel.setQueue(queue);
  searchView.refreshQueuedStates();
  if (currentView === 'files') filesView.renderMain();
  updateRail();
  try {
    state.queue = await api.saveQueue(queue);
  } catch (err) {
    onError(err);
  }
}

function changeQueue(action, ...args) {
  const q = state.queue;
  switch (action) {
    case 'order':
      return saveQueue({ ...q, order: args[0] });
    case 'paused':
      return saveQueue(Q.patchItem(q, args[0], { paused: args[1] }));
    case 'skipped':
      return saveQueue(Q.patchItem(q, args[0], { skipped: args[1] }));
    case 'remove': {
      const item = q.items.find((i) => i.id === args[0]);
      const next = Q.removeItems(q, [args[0]]);
      saveQueue(next);
      if (item) toast(`Removed ${item.title}`, { action: 'Undo', onAction: () => saveQueue(q) });
      return undefined;
    }
    case 'clearPlayed': {
      const before = q;
      saveQueue(Q.clearPlayed(q));
      return toast('Cleared played items', { action: 'Undo', onAction: () => saveQueue(before) });
    }
    case 'clearAll': {
      const before = q;
      saveQueue(Q.clearAll(q));
      return toast('Cleared the queue', { action: 'Undo', onAction: () => saveQueue(before) });
    }
    default:
      return undefined;
  }
}

// ----- playback -----

/**
 * Plays a file: it joins the queue (if not there) and becomes the current item. `start` is
 * what a title page chose: where to start (`positionSecs`, `fromStart`), and for a season pack
 * which episode (`pick`).
 */
function playSource(spec, start = null) {
  // One video at a time: what plays is all the Playing tab holds (more would only download
  // in the background and crowd the page). Playing the same video again keeps its item; an
  // episode in a season pack is always its own (which file it is is known only once the
  // torrent is).
  const same = start?.pick ? null : Q.findItem(state.queue, spec);
  const item = same ?? Q.makeItem(spec);
  return playItem(item, { ...state.queue, items: [item], current: item.id }, { start });
}

/** Counts Play presses: only the latest one may take over the player. */
let playSeq = 0;

/**
 * The copies tried since the viewer last pressed Play, so a switch never goes back to one.
 * `keep` is set when they asked to stay with a copy (Undo on the switch).
 */
let copyRun = { tried: new Set(), switches: 0, keep: false, toldNone: false };

async function playItem(item, queue = state.queue, { switching = false, start = null } = {}) {
  const seq = ++playSeq;
  const pressedAt = performance.now();
  if (!switching) copyRun = { tried: new Set(), switches: 0, keep: false, toldNone: false };
  if (item.infoHash) copyRun.tried.add(item.infoHash.toLowerCase());
  const key = item.infoHash ?? item.source;
  markBusy([item.source, item.infoHash], true);
  stage.classList.remove('idle');
  nav.go({ view: 'player' });
  // On a TV its own player opens now, while the torrent is found.
  if (native) player.prepareNative(seq, item.title);
  state.opening = item.title;
  showLoadingStage(item.title);
  // No peer sending even the torrent's details in time: another copy may have live peers.
  let opened = false;
  const detailsTimer = setTimeout(() => {
    if (!opened && seq === playSeq) switchCopy(item, 'no peer sent its details', queue);
  }, NO_DATA_MS);
  try {
    const info = await api.startStream({
      source: item.source,
      infoHash: item.infoHash,
      fileIndex: item.fileIndex,
      pick: item.fileIndex === null ? (start?.pick ?? null) : null,
      positionSecs: start?.positionSecs ?? null,
      fromStart: start?.fromStart === true,
    });
    opened = true;
    console.info(`[timing] play ${seq} "${item.title}": stream ready +${Math.round(performance.now() - pressedAt)} ms`);
    // Something else was pressed meanwhile: that one is what plays.
    if (seq !== playSeq) return;
    copyRun.tried.add(info.infoHash.toLowerCase());
    // The same stream again (Play pressed twice, or a copy already playing): keep watching, no
    // reload; it is this item's now.
    if (state.playing && state.playing.info.streamId === info.streamId) {
      state.playing.itemId = item.id;
      await saveQueue(Q.setCurrent(queue, item.id));
      queuePanel.renderList();
      replace(stage, player.el);
      if (native) player.resumeNative();
      return;
    }
    // The file is known now: remember it so the item always plays the same file.
    let patched = Q.patchItem(Q.setCurrent(queue, item.id), item.id, {
      fileIndex: info.fileIndex,
      infoHash: info.infoHash,
      title: item.fileIndex === null && item.title === item.torrentName ? info.fileName : item.title,
      torrentName: info.torrentName,
      sizeBytes: info.length,
    });
    // An episode of a pack that was queued already: one row for it, the one playing.
    const twins = patched.items.filter((i) => i.id !== item.id && i.infoHash === info.infoHash && i.fileIndex === info.fileIndex).map((i) => i.id);
    if (twins.length > 0) patched = Q.removeItems(patched, twins);
    // Playing is set before the queue redraws, so its row says Playing, not Last played.
    state.playing = { info, itemId: item.id, ended: false };
    // The video first; the queue is saved meanwhile.
    replace(stage, player.el);
    player.load(info);
    saveQueue(patched);
    queuePanel.renderList();
    updateRail();
    refreshTorrents();
  } catch (err) {
    // Overtaken by a newer Play: not an error, and not this press's to show.
    if (seq !== playSeq || err.kind === 'superseded') return;
    if (native) player.cancelNative(seq);
    state.playing = null;
    queuePanel.renderList();
    showIdleStage(err.message);
    onError(err);
  } finally {
    clearTimeout(detailsTimer);
    markBusy([item.source, item.infoHash, key], false);
  }
}

/** A release name short enough for a toast. */
const shortName = (name) => (name.length > 60 ? `${name.slice(0, 57)}…` : name);

/**
 * The copy playing sent nothing in time: the next copy of the same film or episode that Browse
 * or a search knows about plays instead, in its place in the queue. A toast says so and offers
 * to go back; after a few copies, or with none left, the current one keeps trying.
 */
function switchCopy(item, why, intended = state.queue) {
  const run = copyRun;
  if (run.keep || !settings().playback.switchDeadCopies) return;
  const name = item.torrentName ?? item.title;
  if (item.infoHash) run.tried.add(item.infoHash.toLowerCase());
  const next = run.switches < MAX_SWITCHES ? otherCopies(name, [...browseView.knownTorrents(), ...titleView.knownTorrents(), ...searchView.knownResults()], run.tried)[0] : null;
  if (!next) {
    if (!run.toldNone) {
      run.toldNone = true;
      toast(run.switches > 0 ? `No copy has sent anything yet; still trying “${shortName(name)}”.` : `“${shortName(name)}” has sent nothing yet (${why}), and no other copy of it is known. Still trying.`, { ms: 8000 });
    }
    return;
  }
  run.switches += 1;
  run.tried.add(next.infoHash.toLowerCase());
  const before = state.queue;
  const hash = next.infoHash.toLowerCase();
  // A copy already in the queue is played from its row; else the new copy takes the old one's
  // place (where it was going, if not saved yet).
  const queued = Q.findItem(before, { infoHash: hash, source: next.link, fileIndex: null });
  const replacement = queued ?? Q.makeItem({ source: next.link, infoHash: hash, fileIndex: null, title: next.title, torrentName: next.title, sizeBytes: next.sizeBytes ?? null });
  let items;
  if (queued) items = before.items.filter((i) => i.id !== item.id);
  else if (before.items.some((i) => i.id === item.id)) items = before.items.map((i) => (i.id === item.id ? replacement : i));
  else {
    const at = intended.items.findIndex((i) => i.id === item.id);
    items = [...before.items];
    items.splice(at < 0 ? items.length : Math.min(at, items.length), 0, replacement);
  }
  const queue = { ...before, items, current: replacement.id };
  // Only the dead copy stops: a video still playing while it was opening keeps playing.
  if (state.playing?.itemId === item.id) stopPlayback();
  saveQueue(queue);
  toast(`“${shortName(name)}” sent nothing in ${NO_DATA_MS / 1000} seconds (${why}), so another copy is playing: “${shortName(next.title)}”.`, {
    ms: 12_000,
    action: 'Undo',
    onAction: () => {
      if (copyRun !== run) return;
      // Back to the copy that was chosen, and no more switching for it.
      run.keep = true;
      const back = before.items.some((i) => i.id === item.id) ? before : intended;
      const restored = { ...back, current: item.id };
      if (state.playing) stopPlayback();
      saveQueue(restored);
      playItem(item, restored, { switching: true });
    },
  });
  playItem(replacement, queue, { switching: true });
}

function playNext() {
  const next = Q.nextItem(state.queue);
  if (!next) return toast('Nothing more in the queue.');
  stopPlayback();
  playItem(next);
}

function playPrevious() {
  const prev = Q.previousItem(state.queue);
  if (!prev) return;
  stopPlayback();
  playItem(prev);
}

function onEnded() {
  if (state.playing) state.playing.ended = true;
  const q = state.queue;
  if (q.current) saveQueue(Q.markPlayed(q, q.current));
  else queuePanel.renderList();
  const next = Q.nextItem(state.queue);
  if (next && settings().playback.autoplayNext) player.showUpNext(next);
}

function stopPlayback() {
  const p = state.playing;
  if (!p) return;
  player.unload();
  api.stopStream(p.info.streamId).catch(() => {});
  state.playing = null;
  queuePanel.renderList();
  updateRail();
}

function showIdleStage(message = null) {
  stage.classList.add('idle');
  replace(
    stage,
    h(
      'div.placeholder',
      null,
      h('h2', null, 'Nothing playing'),
      h('p', null, message ?? 'Pick something on Browse, or search for a film, show, album, or lecture.'),
      h('button.btn.primary', { type: 'button', onclick: () => navigate('search') }, 'Search'),
    ),
  );
}

function showLoadingStage(title) {
  if (state.playing) return;
  stage.classList.add('idle');
  replace(stage, h('div.placeholder', null, h('div.loading', null, h('span.spinner'), `Opening ${title}…`)));
}

// ----- background polling -----

setInterval(async () => {
  try {
    state.downloads = await api.queueDownloads();
  } catch {
    return;
  }
  queuePanel.setDownloads(state.downloads);
  const link = state.downloads.link;
  if (link) {
    const idle = link.usedBps === 0 && link.uploadBps === 0;
    replace(bottomBar, h('span.rates', { class: idle ? 'idle' : '', title: 'Total download and upload speed of all torrents' }, `↓ ${formatRate(link.usedBps)} · ↑ ${formatRate(link.uploadBps)}`), state.playing ? h('span', null, `Playing: ${state.playing.info.fileName}`) : null);
  }
}, DOWNLOADS_POLL_MS);

setInterval(async () => {
  if (currentView !== 'player' || !settings().playback.optimizeQueue) return;
  const ids = state.queue.items.filter((i) => !i.played && !i.skipped).map((i) => i.id);
  if (ids.length < 2) return;
  let readiness;
  try {
    readiness = await api.queueReadiness(ids);
  } catch {
    return;
  }
  const before = state.queue;
  const optimized = Q.optimize(before, readiness, settings().playback.keepCourseOrder);
  if (optimized) {
    saveQueue(optimized);
    toast('Moved ready videos ahead', { action: 'Undo', onAction: () => saveQueue(before) });
  }
}, READINESS_POLL_MS);

// ----- events from the main process -----

api.on('search-progress', ({ searchId, progress }) => searchView.handleProgress(searchId, progress));
api.on('preload-status', (status) => {
  // A title page's warm-up is its own: search's best pick has its own preload.
  if (status?.reason === 'title') titleView.setPreload(status);
  else {
    searchView.setPreload(status);
    if (!status) titleView.setPreload(null);
  }
});
api.on('thumbnail', (payload) => searchView.handleThumbnail(payload));
api.on('prefetched', (payload) => searchView.handlePrefetched(payload));
api.on('browse-rows', (view) => browseView.setRows(view));
api.on('title-meta', (payload) => {
  browseView.handleMeta(payload);
  titleView.handleMeta(payload);
});
api.on('library-changed', () => {
  if (currentView === 'library') libraryView.refresh();
});
api.on('torrent-error', ({ message }) => toast(message, { kind: 'error' }));
api.on('engine-error', ({ message, restarting }) => toast(restarting ? `The torrent engine hit a network error (${message}) and is restarting.` : `Torrent engine: ${message}`, { kind: 'error', ms: 8000 }));
// A stream the main process closed under the player (another video started, its torrent went
// away): the player lets it go, instead of reporting the 404 that follows as a file it cannot play.
api.on('stream-stopped', ({ streamId, reason }) => {
  const p = state.playing;
  if (reason === 'request' || !p || p.info.streamId !== streamId) return;
  player.unload();
  state.playing = null;
  queuePanel.renderList();
  updateRail();
  // Replaced: the new video is on its way and takes the stage when it opens.
  if (reason === 'replaced') return showLoadingStage(state.opening ?? 'the next video');
  showIdleStage(reason === 'removed' ? 'Its torrent was removed, so playback stopped.' : 'Playback stopped.');
});

// Sharing to TVs started, stopped or ran into a problem.
api.on('share-status', (status) => settingsView.setShare(status));

// Settings changed outside the Settings page (it updates this copy itself as you edit).
api.on('settings-changed', (view) => {
  state.settings = view;
  queuePanel.renderMenu();
});

api.on('engine-restarted', ({ lost }) => {
  toast(lost > 0 ? 'The torrent engine restarted. Press Play again to resume; queued downloads pick up by themselves.' : 'The torrent engine restarted.', { ms: 8000 });
  refreshTorrents();
});
api.on('open-torrent', (req) => {
  if (req.kind === 'magnet') openLink(req.value, { play: req.play === true });
  else if (req.kind === 'file' && req.value instanceof Uint8Array) openFile(req.value, req.name ?? '');
});

// Android TV: what the TV's player reports, and the remote.
if (native) api.on('native-player', (ev) => player.handleNative(ev));
const tv = isTv(api) ? startTv({ api, nav, exit: () => window.tpNative?.exit() }) : null;

// ----- keyboard, mouse, drag and drop -----

document.addEventListener('keydown', (e) => {
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'f') return (e.preventDefault(), nav.go({ view: 'search', searchId: null }), searchView.focus());
    if (k === 'b') return (e.preventDefault(), navigate('browse'));
    if (k === 'o') return (e.preventDefault(), navigate('open'));
    if (k === ',') return (e.preventDefault(), navigate('settings'));
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft') return (e.preventDefault(), nav.back());
  if (e.altKey && e.key === 'ArrowRight') return (e.preventDefault(), nav.forward());
  if (typing) {
    if (e.key === 'Escape') target.blur();
    return;
  }
  if (currentView === 'player' || e.key === ' ') {
    if (currentView !== 'player' && e.key === ' ' && !state.playing) return;
    if (player.handleKey(e)) e.preventDefault();
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 3) nav.back();
  else if (e.button === 4) nav.forward();
});
document.addEventListener('fullscreenchange', () => {
  document.getElementById('app').classList.toggle('fullscreen', Boolean(document.fullscreenElement));
});

const drop = document.getElementById('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth += 1;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) drop.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const file = [...e.dataTransfer.files].find((f) => isTorrentFile(f.name));
  const text = e.dataTransfer.getData('text/plain')?.trim();
  if (file) openFile(new Uint8Array(await file.arrayBuffer()), file.name);
  else if (text && /^magnet:\?/i.test(text)) openLink(text);
  else toast('Drop a .torrent file or a magnet link.', { kind: 'error' });
});

// ----- start-up -----

(async () => {
  try {
    const [settingsView, queue] = await Promise.all([api.getSettings(), api.loadQueue()]);
    state.settings = settingsView;
    // A queue saved by an earlier version keeps only the video that was playing.
    const current = queue.items.filter((i) => i.id === queue.current);
    state.queue = { ...queue, items: current, current: current[0]?.id ?? null };
    if (current.length !== queue.items.length) api.saveQueue(state.queue).catch(() => {});
    settingsView.warnings.forEach((w) => toast(w, { ms: 9000 }));
  } catch (err) {
    onError(err);
  }
  queuePanel.setQueue(state.queue);
  showIdleStage();
  await refreshTorrents();
  showView(nav.current);
  tv?.ensureFocus();
  api.rendererReady().catch(() => {});
})();

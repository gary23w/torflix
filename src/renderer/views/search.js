// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The search page. Each search is kept for the session, so Back and Forward move between
// recent searches without searching again. Results stream in as indexers answer; the best
// pick is preloaded quietly once it has held for two seconds.

import { h, icon, ICONS, replace, clear, closeOnOutside } from '../lib/dom.js';
import { formatBytes, formatPublished, plural } from '../../shared/format.js';
import { looksLikeLink } from '../../shared/files.js';

const CATEGORIES = [
  { label: 'All', ids: [] },
  { label: 'Movies', ids: [2000] },
  { label: 'TV', ids: [5000] },
  { label: 'Music', ids: [3000] },
  { label: 'Audiobooks', ids: [3030] },
  { label: 'Other', ids: [8000] },
];
const RES_ORDER = { '2160p': 3, '1080p': 2, '720p': 1, '480p': 0 };
const SETTLE_MS = 2000;
const MAX_CACHED = 20;
/** How long after results change before the ones on screen are prefetched. */
const PREFETCH_DEBOUNCE_MS = 700;
const PREFETCH_COUNT = 12;

/** Whether a frame of a result's video can be shown by the built-in player. */
export function framePossible(quality) {
  return quality.playable !== 'needsFullPlayer' && quality.kind !== 'audio' && quality.kind !== 'notVideo';
}

/**
 * While the pointer (or focus) is in the list, rows keep their places: rows already shown stay
 * in their order and new rows join at the end, so nothing jumps under the pointer.
 */
export function holdOrder(previousKeys, rows) {
  if (previousKeys.length === 0) return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const kept = previousKeys.map((k) => byKey.get(k)).filter(Boolean);
  const seen = new Set(kept.map((r) => r.key));
  return [...kept, ...rows.filter((r) => !seen.has(r.key))];
}

export const DEFAULT_FILTERS = { resolution: 'any', playableOnly: false, minSeeders: 0, sort: 'rank', text: '', indexer: '', kind: 'any' };
const RECENT_KEY = 'tp.recentSearches';
const MAX_RECENT = 10;

export function recentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((q) => typeof q === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(query) {
  try {
    const list = recentSearches().filter((q) => q.toLowerCase() !== query.toLowerCase());
    list.unshift(query);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // storage unavailable
  }
}

export function forgetSearches() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // storage unavailable
  }
}

/** Client-side filters over the results on screen. */
export function applyFilters(results, f) {
  let out = results;
  if (f.indexer) out = out.filter((r) => r.indexers.includes(f.indexer));
  if (f.kind === 'video') out = out.filter((r) => r.quality.kind === 'video' || r.quality.kind === 'unknown');
  else if (f.kind === 'audio') out = out.filter((r) => r.quality.kind === 'audio');
  if (f.resolution !== 'any') out = out.filter((r) => r.quality.resolution === f.resolution);
  if (f.playableOnly) out = out.filter((r) => r.quality.playable === 'plays' || r.quality.playable === 'likely');
  if (f.minSeeders > 0) out = out.filter((r) => (r.seeders ?? 0) >= f.minSeeders);
  if (f.text.trim()) {
    const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
    out = out.filter((r) => words.every((w) => r.title.toLowerCase().includes(w)));
  }
  if (f.sort === 'seeders') out = [...out].sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  else if (f.sort === 'size') out = [...out].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  else if (f.sort === 'newest') out = [...out].sort((a, b) => (Date.parse(b.published ?? '') || 0) - (Date.parse(a.published ?? '') || 0));
  else if (f.sort === 'resolution') out = [...out].sort((a, b) => (RES_ORDER[b.quality.resolution] ?? -1) - (RES_ORDER[a.quality.resolution] ?? -1));
  return out;
}

/** An indexer's error, shortened for the list. */
function shortError(error) {
  const e = String(error);
  if (/skipped after/i.test(e)) return 'skipped: failing lately';
  if (/excluded by default/i.test(e)) return 'excluded by default';
  if (/timed? ?out/i.test(e)) return 'timed out';
  return e.length > 60 ? `${e.slice(0, 57)}…` : e;
}

export function preloadLabel(status, infoHash) {
  if (!status || !infoHash || status.infoHash !== infoHash) return null;
  switch (status.phase) {
    case 'resolving':
      return 'finding the video…';
    case 'buffering':
      return `preloading ${Math.floor(status.progress * 100)}%`;
    case 'ready':
      return 'ready to play';
    case 'failed':
      return 'preload failed';
    default:
      return null;
  }
}

export class SearchView {
  constructor(root, { api, settings, onPlay, onAdd, onOpenTitle, onLink, queuedState, onSearchStarted, isBusy, onError }) {
    this.root = root;
    this.api = api;
    this.settings = settings;
    this.onPlay = onPlay;
    this.onAdd = onAdd;
    this.onOpenTitle = onOpenTitle;
    this.onLink = onLink;
    this.queuedState = queuedState;
    this.onSearchStarted = onSearchStarted;
    this.isBusy = isBusy;
    this.onError = onError;
    /** @type {Map<number, {id:number, query:string, categories:number[], progress:any, filters:any, expanded:Set<string>, error:string|null}>} */
    this.searches = new Map();
    /** Progress that arrived before its search's id did (a cached search answers at once). */
    this.early = new Map();
    /** A render running, and one asked for meanwhile (null: none; else whether it is soft). */
    this.rendering = false;
    this.renderAgain = null;
    this.currentId = null;
    this.preload = null;
    this.settle = null;
    this.settleKey = null;
    /** Pictures from inside the torrents, as `data:` URLs, by result key. */
    this.thumbnails = new Map();
    /** Posters looked up from the release name (TVmaze, Wikipedia), by result key; null = none. */
    this.posters = new Map();
    /** Results whose torrent metadata is already fetched, so playing them starts sooner. */
    this.prefetched = new Set();
    /** The preloaded best pick's video, for a frame of its start. */
    this.frame = null;
    this.frameFailed = null;
    this.prefetchTimer = null;
    this.held = false;
    this.lastKeys = [];
    /** Row elements by result key with the inputs they were built from, so unchanged rows are reused. */
    this.rowCache = new Map();
    this.render();
  }

  get current() {
    return this.currentId === null ? null : this.searches.get(this.currentId) ?? null;
  }

  render() {
    this.input = h('input', { type: 'search', placeholder: 'Search for a film, show, album, lecture…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search' });
    this.category = h(
      'select',
      { 'aria-label': 'Category' },
      CATEGORIES.map((c, i) => h('option', { value: String(i) }, c.label)),
    );
    this.form = h(
      'form.search-form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          this.search(this.input.value);
        },
      },
      h('div.search-box', null, this.input, this.category),
      h('button.btn.primary', { type: 'submit' }, 'Search'),
    );
    this.recent = h('div.recent');
    this.hero = h(
      'div.search-hero',
      null,
      h('h1', null, 'Torflix'),
      h('p.tagline', null, 'Stream at the speed of the swarm. Any torrent starts in seconds and skips to any moment.'),
      this.form,
      h('p.search-hint', null, 'Or paste a magnet link or a .torrent link here. Search asks a public index; what you play is your responsibility.'),
      this.recent,
    );
    this.results = h('section.results', { 'aria-label': 'Search results' });
    replace(this.root, h('div.page.warm.search-page', null, this.hero, this.results));
    this.renderRecent();
  }

  renderRecent() {
    const list = recentSearches();
    if (list.length === 0) return clear(this.recent);
    replace(
      this.recent,
      h('span.recent-label', null, 'Recent'),
      list.map((q) => h('button.chip', { type: 'button', title: `Search again for “${q}”`, onclick: () => this.search(q) }, q)),
      h('button.chip.ghost', { type: 'button', title: 'Forget recent searches', onclick: () => (forgetSearches(), this.renderRecent()) }, 'Clear'),
    );
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  /** Shows a search from the cache (or the empty page for null). */
  show(searchId) {
    if (searchId !== this.currentId) {
      this.rowCache.clear();
      this.lastKeys = [];
    }
    this.currentId = searchId;
    const s = this.current;
    this.hero.classList.toggle('compact', s !== null);
    if (s) {
      this.input.value = s.query;
      const ci = CATEGORIES.findIndex((c) => JSON.stringify(c.ids) === JSON.stringify(s.categories));
      this.category.value = String(Math.max(0, ci));
    }
    this.renderResults();
    this.schedulePreload();
    this.schedulePrefetch();
  }

  /** Asks for the metadata and pictures of the results on screen, a moment after they settle. */
  schedulePrefetch() {
    clearTimeout(this.prefetchTimer);
    const s = this.current;
    if (!s?.progress) return;
    this.prefetchTimer = setTimeout(async () => {
      if (this.current !== s) return;
      const rows = applyFilters(s.progress.response.results, s.filters).slice(0, PREFETCH_COUNT);
      try {
        const snap = await this.api.prefetchResults(rows.map((r) => ({ key: r.key, link: r.link, infoHash: r.infoHash })));
        let changed = false;
        for (const [key, image] of Object.entries(snap.thumbnails)) if (!this.thumbnails.has(key)) (this.thumbnails.set(key, image), (changed = true));
        for (const key of snap.prefetched) if (!this.prefetched.has(key)) (this.prefetched.add(key), (changed = true));
        if (changed && this.current === s) this.renderResults(true);
      } catch {
        // prefetch is best effort
      }
      // Posters from the release names, for rows without a picture of their own.
      if (this.settings().browse?.fetchInfo) {
        for (const r of rows) {
          if (this.current !== s) break;
          if (this.posters.has(r.key) || this.thumbnails.has(r.key)) continue;
          this.posters.set(r.key, null);
          try {
            const meta = await this.api.lookupRelease(r.title);
            if (meta?.poster) {
              this.posters.set(r.key, meta.poster);
              if (this.current === s) this.renderResults(true);
            }
          } catch {
            // no poster
          }
        }
      }
    }, PREFETCH_DEBOUNCE_MS);
  }

  handleThumbnail({ key, image }) {
    if (typeof key !== 'string' || typeof image !== 'string' || !image.startsWith('data:image/')) return;
    this.thumbnails.set(key, image);
    if (this.current) this.renderResults(true);
  }

  handlePrefetched({ key }) {
    if (typeof key !== 'string') return;
    this.prefetched.add(key);
    if (this.current) this.renderResults(true);
  }

  async search(text) {
    const query = text.trim();
    if (!query) return;
    if (looksLikeLink(query)) {
      this.input.value = '';
      this.onLink(query);
      return;
    }
    const categories = CATEGORIES[Number(this.category.value)]?.ids ?? [];
    let id;
    try {
      id = await this.api.searchTorrents(query, { categories });
    } catch (err) {
      this.onError(err);
      return;
    }
    this.searches.set(id, { id, query, categories, progress: null, filters: { ...DEFAULT_FILTERS }, expanded: new Set(), error: null });
    this.evict();
    rememberSearch(query);
    this.renderRecent();
    this.indexersOpen = false;
    // A new search starts the prefetch over; pictures of earlier searches are forgotten with it.
    this.thumbnails.clear();
    this.prefetched.clear();
    this.onSearchStarted(id);
    this.show(id);
    const early = this.early.get(id);
    this.early.clear();
    if (early) this.handleProgress(id, early);
  }

  evict() {
    const ids = [...this.searches.keys()];
    if (ids.length <= MAX_CACHED) return;
    const drop = ids.slice(0, ids.length - MAX_CACHED);
    for (const id of drop) this.searches.delete(id);
    this.onForget?.(drop);
  }

  handleProgress(searchId, progress) {
    const s = this.searches.get(searchId);
    if (!s) {
      // Its id is on the way; one search runs at a time, so the latest is all that is kept.
      this.early.clear();
      this.early.set(searchId, progress);
      return;
    }
    s.progress = progress;
    if (progress.error && progress.response.results.length === 0) s.error = progress.error;
    if (searchId === this.currentId) {
      this.renderResults(true);
      this.schedulePreload();
      this.schedulePrefetch();
    }
  }

  setPreload(status) {
    this.preload = status;
    if (status && status.phase === 'ready') {
      if (this.frame?.infoHash !== status.infoHash) {
        this.api.previewFrame().then(
          (frame) => {
            this.frame = frame;
            if (this.current) this.renderResults(true);
          },
          () => {},
        );
      }
    } else if (!status || status.phase === 'cancelled' || status.phase === 'failed' || this.frame?.infoHash !== status.infoHash) {
      this.frame = null;
    }
    if (this.current) this.renderResults(true);
  }

  /** Preloads the best pick once it has held for 2 s (or the search finished). */
  schedulePreload() {
    clearTimeout(this.settle);
    const s = this.current;
    if (!s?.progress || !this.settings().search.preloadTopResult) return;
    const best = s.progress.response.results.find((r) => r.bestPick);
    if (!best || !best.magnet) return;
    const key = `${s.id}:${best.key}`;
    const start = () => {
      if (this.current !== s) return;
      if (this.preload && this.preload.infoHash === best.infoHash && this.preload.phase !== 'failed') return;
      if (this.requestedPreload === key) return;
      this.requestedPreload = key;
      this.api.preloadBest({ link: best.link, infoHash: best.infoHash }).then((st) => this.setPreload(st), () => {});
    };
    if (this.settleKey !== key) {
      this.settleKey = key;
      this.settleSince = Date.now();
    }
    const held = Date.now() - this.settleSince;
    if (s.progress.done || held >= SETTLE_MS) start();
    else this.settle = setTimeout(start, SETTLE_MS - held);
  }

  refreshQueuedStates() {
    if (this.current) this.renderResults(true);
  }

  /** Every result of the searches still in memory (other copies to switch to). */
  knownResults() {
    return [...this.searches.values()].flatMap((s) => s.progress?.response?.results ?? []);
  }

  /**
   * Draws the results. Replacing the list can take focus from a row, and older Chromium (the
   * WebView of many Android TV boxes) fires focusout right then, in the middle of the
   * replace: a render asked for from there runs once this one is done, not inside it.
   */
  renderResults(soft = false) {
    if (this.rendering) {
      this.renderAgain = this.renderAgain === null ? soft : this.renderAgain && soft;
      return;
    }
    this.rendering = true;
    this.renderAgain = null;
    try {
      this.drawResults(soft);
    } finally {
      this.rendering = false;
    }
    if (this.renderAgain !== null) this.renderResults(this.renderAgain);
  }

  drawResults(soft) {
    const s = this.current;
    if (!s) return clear(this.results);
    const p = s.progress;
    if (!p) return replace(this.results, h('p.counts', null, h('span.pending', null, h('span.pulse'), `Searching for “${s.query}”…`)));
    const all = p.response.results;
    let rows = applyFilters(all, s.filters);
    if (this.held) rows = holdOrder(this.lastKeys, rows);
    this.lastKeys = rows.map((r) => r.key);
    const searching = !p.done ? (p.total > p.completed ? `searching ${plural(p.total - p.completed, 'more source')}…` : 'searching…') : null;
    const indexers = p.response.indexers;
    const failed = indexers.filter((i) => i.error).length;
    const answered = indexers.filter((i) => !i.error).length;
    const bestHidden = all.some((r) => r.bestPick) && !rows.some((r) => r.bestPick);
    const indexerSummary = searching ? `${answered} answered` : failed > 0 ? `${failed} of ${indexers.length} indexers did not respond` : `${plural(indexers.length, 'indexer')} answered`;
    const counts = h(
      'p.counts',
      null,
      `${plural(all.length, 'result')}${rows.length !== all.length ? ` · ${rows.length} shown` : ''}`,
      p.response.excludedAdult > 0 ? ` · ${plural(p.response.excludedAdult, 'adult result')} hidden` : '',
      searching ? [' · ', h('span.pending', null, h('span.pulse'), searching)] : '',
      indexers.length > 0 ? [' · ', this.renderIndexers(indexers, indexerSummary)] : '',
      p.cached ? ' · from the last 10 minutes' : '',
    );
    const list =
      all.length === 0
        ? p.done
          ? h('p.empty', null, s.error ? s.error : 'Nothing found. Try different or fewer words.')
          : null
        : rows.length === 0
          ? h('p.empty', null, 'Every result is hidden by the filters.')
          : h(
              'ul.result-list',
              {
                onpointerenter: () => {
                  this.held = true;
                },
                onpointerleave: () => {
                  if (!this.results.contains(document.activeElement) || !this.results.querySelector('.result-list')?.contains(document.activeElement)) this.release();
                },
                onfocusin: () => {
                  this.held = true;
                },
                onfocusout: (e) => {
                  if (!e.currentTarget.contains(e.relatedTarget) && !e.currentTarget.matches(':hover')) this.release();
                },
              },
              rows.map((r) => this.renderResult(r, s)),
            );
    // Rows not shown any more are forgotten, so the cache cannot grow past the results.
    const shown = new Set(rows.map((r) => r.key));
    for (const key of [...this.rowCache.keys()]) if (!shown.has(key)) this.rowCache.delete(key);
    // Rows are reused, but moving them into the new list takes focus from the one that had it
    // (a keyboard or TV remote would be left on nothing as results stream in): it goes back.
    const focused = this.results.contains(document.activeElement) ? document.activeElement : null;
    replace(this.results, counts, all.length > 0 ? this.renderFilters(s, bestHidden) : null, list);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    if (!soft) this.results.scrollTop = 0;
  }

  /** The pointer left the list: rows take their true order again. */
  release() {
    if (!this.held) return;
    this.held = false;
    if (this.current) this.renderResults(true);
  }

  /** The counts line's indexer summary: a button that lists every indexer and how it did. */
  renderIndexers(indexers, summary) {
    const menu = h('span.menu.inline');
    const render = (open) => {
      const sorted = [...indexers].sort((a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error)) || b.results - a.results || a.name.localeCompare(b.name));
      replace(
        menu,
        h('button.linkish.quiet', { type: 'button', 'aria-expanded': open ? 'true' : 'false', title: 'Every indexer asked, and how it did', onclick: () => render(!open) }, summary),
        open
          ? h(
              'ul.popup.down.indexers',
              { role: 'list' },
              sorted.map((i) =>
                h(
                  'li.indexer',
                  { class: i.error ? 'failed' : '' },
                  h('span.name', null, i.name),
                  h('span.detail', null, i.error ? shortError(i.error) : plural(i.results, 'result')),
                ),
              ),
            )
          : null,
      );
      this.indexersOpen = open;
      if (open) closeOnOutside(menu, () => render(false));
    };
    render(this.indexersOpen === true);
    return menu;
  }

  renderFilters(s, bestHidden) {
    const f = s.filters;
    const set = (patch) => {
      Object.assign(f, patch);
      this.renderResults(true);
    };
    const indexerNames = [...new Set(s.progress.response.results.flatMap((r) => r.indexers))].sort((a, b) => a.localeCompare(b));
    const hasAudio = s.progress.response.results.some((r) => r.quality.kind === 'audio');
    const chip = (label, on, onclick) => h('button.chip', { type: 'button', class: on ? 'on' : '', 'aria-pressed': on ? 'true' : 'false', onclick }, label);
    const select = (label, value, options, onchange) =>
      h(
        'select',
        { 'aria-label': label, value, onchange: (e) => onchange(e.target.value) },
        options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)),
      );
    return h(
      'div.filters',
      { role: 'group', 'aria-label': 'Filters' },
      ['any', '2160p', '1080p', '720p', '480p'].map((r) => chip(r === 'any' ? 'Any quality' : r, f.resolution === r, () => set({ resolution: r }))),
      h('span.sep'),
      chip('Plays in built-in player', f.playableOnly, () => set({ playableOnly: !f.playableOnly })),
      h('span.sep'),
      select('Minimum seeders', String(f.minSeeders), [['0', 'Any seeders'], ['1', '1+ seeders'], ['10', '10+ seeders'], ['50', '50+ seeders']], (v) => set({ minSeeders: Number(v) })),
      hasAudio ? select('Kind', f.kind, [['any', 'Video and audio'], ['video', 'Video only'], ['audio', 'Audio only']], (v) => set({ kind: v })) : null,
      indexerNames.length > 1 ? select('Indexer', f.indexer, [['', 'All indexers'], ...indexerNames.map((n) => [n, n])], (v) => set({ indexer: v })) : null,
      select('Sort', f.sort, [['rank', 'Best first'], ['seeders', 'Most seeders'], ['size', 'Largest'], ['resolution', 'Highest resolution'], ['newest', 'Newest']], (v) => set({ sort: v })),
      h('input', { type: 'search', class: 'chip', placeholder: 'Filter titles', value: f.text, 'aria-label': 'Filter titles', oninput: (e) => set({ text: e.target.value }) }),
      JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS) ? h('button.chip.ghost', { type: 'button', onclick: () => set({ ...DEFAULT_FILTERS }) }, 'Reset') : null,
      bestHidden ? h('span.note', null, 'The best pick is hidden by the filters.') : null,
    );
  }

  renderResult(r, s) {
    const open = s.expanded.has(r.key);
    const queued = this.queuedState(r);
    const busy = this.isBusy(r.link, r.infoHash);
    const preloaded = preloadLabel(this.preload, r.infoHash);
    const picture = this.thumbnails.get(r.key) ?? this.posters.get(r.key) ?? null;
    const frameUrl = r.bestPick && this.frame && this.frame.infoHash === r.infoHash && this.frameFailed !== this.frame.url && framePossible(r.quality) ? this.frame.url : null;
    const ready = !preloaded && this.prefetched.has(r.key);
    // Everything the row is built from; an unchanged row is reused, so pictures and the frame never reload.
    const signature = JSON.stringify([r.title, r.seeders, r.peers, r.sizeBytes, r.indexers, r.health, r.reason, r.bestPick, r.suspicious, r.published, open, queued, busy, preloaded, picture !== null, frameUrl, ready]);
    const cached = this.rowCache.get(r.key);
    if (cached && cached.signature === signature) return cached.el;
    const el = this.buildResult(r, s, { open, queued, busy, preloaded, picture, frameUrl, ready });
    this.rowCache.set(r.key, { el, signature });
    return el;
  }

  buildResult(r, s, { open, queued, busy, preloaded, picture, frameUrl, ready }) {
    const meta = [
      r.sizeBytes !== null ? formatBytes(r.sizeBytes) : null,
      r.seeders !== null ? `${r.seeders} seeders` : 'seeders unknown',
      r.peers !== null ? `${r.peers} peers` : null,
      r.quality.label || null,
      r.quality.codec,
      r.quality.container,
      formatPublished(r.published),
    ]
      .filter(Boolean)
      .join(' · ');
    const toggle = () => {
      if (s.expanded.has(r.key)) s.expanded.delete(r.key);
      else s.expanded.add(r.key);
      this.renderResults(true);
    };
    const kindIcon = r.quality.kind === 'audio' ? ICONS.music : ICONS.film;
    let thumb;
    if (frameUrl) {
      const video = h('video', { src: frameUrl, muted: true, playsinline: true, preload: 'metadata', tabindex: '-1', disablepictureinpicture: true });
      video.addEventListener('loadedmetadata', () => {
        // A moment in, not the first (often black) frame; the start of the file is preloaded.
        const t = Number.isFinite(video.duration) && video.duration > 10 ? Math.min(2, video.duration / 20) : 0.5;
        try {
          video.currentTime = t;
        } catch {
          // not seekable yet
        }
      });
      video.addEventListener('error', () => {
        this.frameFailed = frameUrl;
        this.renderResults(true);
      });
      thumb = h('div.thumb', { 'aria-hidden': 'true' }, video);
    } else if (picture) {
      thumb = h('div.thumb', { 'aria-hidden': 'true' }, h('img', { src: picture, alt: '', loading: 'lazy', decoding: 'async' }));
    } else {
      thumb = h('div.thumb', { 'aria-hidden': 'true' }, icon(kindIcon, { size: r.bestPick ? 26 : 18 }));
    }
    const li = h(
      'li.result',
      { class: r.bestPick ? 'best' : '' },
      h(
        'div.row',
        null,
        thumb,
        h(
          'div.text',
          {
            role: 'button',
            tabindex: '-1',
            'aria-expanded': open ? 'true' : 'false',
            onclick: toggle,
          },
          h(
            'span.title',
            null,
            r.bestPick ? h('span.pick', null, 'Best pick') : null,
            queued === 'playing' ? h('span.queued-tag', null, 'Playing') : null,
            r.title,
          ),
          r.bestPick ? h('span.reason', null, r.reason, preloaded ? h('span.preload', { 'aria-live': 'polite' }, ` · ${preloaded}`) : null) : null,
          h('span.meta', null, r.health ? h('span.health', { class: r.health, title: `Swarm health: ${r.health}` }) : null, meta),
          h(
            'span.source',
            null,
            r.indexers.join(', '),
            r.suspicious ? ' · suspicious seed count' : '',
            ready ? h('span.ready', { title: 'Torrent details fetched: playing it starts sooner' }, ' · details ready') : null,
          ),
        ),
        h(
          'div.actions',
          null,
          h('button.btn.secondary', { type: 'button', 'aria-expanded': open ? 'true' : 'false', title: open ? 'Hide the details' : 'Show everything known about it', onclick: toggle }, `Details ${open ? '▴' : '▾'}`),
          h('button.btn.primary', { type: 'button', disabled: busy, title: 'Add it and play the video now', onclick: () => this.onPlay(r) }, busy ? 'Loading…' : 'Play'),
          h('button.btn.secondary', { type: 'button', disabled: busy, title: 'Add it and choose a file', onclick: () => this.onAdd(r) }, 'Add'),
          h('button.btn.secondary', { type: 'button', title: 'The film or series: information, every copy, episodes', onclick: () => this.onOpenTitle(r) }, 'Title'),
        ),
      ),
      open ? this.renderDetails(r) : null,
    );
    return li;
  }

  renderDetails(r) {
    const q = r.quality;
    const row = (label, value) => (value === null || value === undefined || value === '' ? null : [h('dt', null, label), h('dd', null, value)]);
    const copyBtn = (text) =>
      h(
        'button.btn.icon-btn.desktop-only',
        {
          type: 'button',
          title: 'Copy',
          'aria-label': 'Copy',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              // clipboard unavailable
            }
          },
        },
        icon(ICONS.copy, { size: 14 }),
      );
    return h(
      'dl.details',
      null,
      row('Why it ranks here', r.reason),
      row('Quality', [q.label, q.codec, q.container, q.audio ? `${q.audio}${q.audioPlays === false ? ' (no sound in built-in player)' : ''}` : null].filter(Boolean).join(' · ') || 'unknown'),
      row('Built-in player', { plays: 'plays', likely: 'likely plays', unlikely: 'may not play', needsFullPlayer: 'needs a full player (VLC, mpv)', unknown: 'unknown' }[q.playable]),
      row('Size', r.sizeBytes !== null ? formatBytes(r.sizeBytes) : null),
      row('Swarm', [r.seeders !== null ? `${r.seeders} seeders` : 'seeders unknown', r.peers !== null ? `${r.peers} peers` : null, r.health ? `health ${r.health}` : null].filter(Boolean).join(' · ')),
      row('Category', r.category),
      row('Indexers', r.indexers.join(', ')),
      row('Published', r.published ? new Date(r.published).toLocaleString() : null),
      row('Info hash', r.infoHash ? h('span', null, h('code', null, r.infoHash), copyBtn(r.infoHash)) : null),
      row('Magnet link', r.magnet ? h('span', null, h('code', null, `${r.magnet.slice(0, 72)}…`), copyBtn(r.magnet)) : null),
      row('Download link', r.download ? h('code', null, r.download) : null),
      row(
        'Details page',
        r.detailsUrl
          ? h('button.linkish', { type: 'button', onclick: () => this.api.openLink(r.detailsUrl).catch(this.onError) }, new URL(r.detailsUrl).host, ' ', icon(ICONS.external, { size: 12 }))
          : null,
      ),
      row('License', r.license ?? 'unknown (not checked by the index)'),
    );
  }
}

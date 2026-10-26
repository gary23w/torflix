// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Browse page: a hero and rows of posters, the way a streaming service opens. The rows
// are what performs best on the swarm (the most seeded films and series on the public index,
// grouped by title) plus what is streaming and airing today; posters and information fill in
// as they arrive. A card opens the title's own page (title.js).

import { h, icon, ICONS, replace, clear } from '../lib/dom.js';
import { posterCard, fillCard, rankCard } from './poster-card.js';
import { parseRelease, titleKey } from '../../shared/release.js';
import { formatTime } from '../../shared/format.js';

/** How long Browse is on screen before its hero's best torrent is preloaded. */
const HERO_PRELOAD_DELAY_MS = 3000;
/** Cards of a top row shown with their rank. */
const TOP_RANKS = 10;
/** Titles in the Continue watching row, most recently watched first. */
const CONTINUE_COUNT = 12;
/** Watched less than this, or this near the end, a video is not worth continuing (the library's rule). */
const CONTINUE_MARGIN_SECS = 10;

/**
 * What the library says is worth continuing, one card per title: the film, or the series at
 * its last episode, with how far it got.
 */
export function continueWatching(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (it.completed || !(it.positionSecs >= CONTINUE_MARGIN_SECS)) continue;
    if (it.durationSecs && it.positionSecs > it.durationSecs - CONTINUE_MARGIN_SECS) continue;
    const file = parseRelease(it.title);
    const torrent = parseRelease(it.torrentName);
    const named = torrent?.kind === 'tv' || file?.kind !== 'tv' ? torrent ?? file : file;
    const p = named && titleKey(named.title) ? named : null;
    if (!p) continue;
    const kind = p.kind === 'tv' || file?.kind === 'tv' ? 'tv' : 'movie';
    const key = kind === 'tv' ? `tv:${titleKey(p.title)}` : `movie:${titleKey(p.title)}:${p.year ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const season = file?.season ?? p.season;
    const episode = file?.episode ?? p.episode;
    const left = it.durationSecs ? it.durationSecs - it.positionSecs : null;
    out.push({
      key,
      kind,
      title: p.title,
      year: kind === 'movie' ? p.year : null,
      seeders: null,
      meta: null,
      release: it.torrentName ?? it.title,
      progress: it.durationSecs ? Math.min(1, it.positionSecs / it.durationSecs) : null,
      note: [kind === 'tv' && season !== null && episode !== null ? `S${season} E${episode}` : null, left !== null ? `${formatTime(left)} left` : `at ${formatTime(it.positionSecs)}`].filter(Boolean).join(' · '),
    });
    if (out.length >= CONTINUE_COUNT) break;
  }
  return out;
}

const SCROLL_STEP = 0.8;

export class BrowseView {
  constructor(root, { api, onPlay, onOpenTitle, onSearch, onError }) {
    this.root = root;
    this.api = api;
    this.onPlay = onPlay;
    this.onOpenTitle = onOpenTitle;
    this.onSearch = onSearch;
    this.onError = onError;
    this.view = null;
    this.loading = false;
    this.cards = new Map();
    this.titles = new Map();
    this.render();
  }

  render() {
    this.hero = h('section.hero');
    this.rowsEl = h('div.rows');
    this.status = h('p.browse-status', { 'aria-live': 'polite' });
    this.continueEl = h('div.rows.continue-rows');
    replace(this.root, h('div.browse', null, this.hero, this.status, this.continueEl, this.rowsEl));
  }

  /** The page is on screen: load it (once) and let the main process fill in information. */
  show() {
    this.api.browseVisible(true).catch(() => {});
    if (!this.view && !this.loading) this.load();
    this.loadContinue();
  }

  /** The Continue watching row, from the library: what was stopped partway, newest first. */
  async loadContinue() {
    const list = continueWatching(await this.api.libraryItems().catch(() => []));
    const signature = list.map((t) => `${t.key}|${t.note}`).join(',');
    // Redrawn only when it changed, and never under the remote's focus.
    if (signature === this.continueSignature || this.continueEl.contains(document.activeElement)) return;
    this.continueSignature = signature;
    if (list.length === 0) return clear(this.continueEl);
    const cards = list.map((t) => {
      const known = this.titles.get(t.key)?.meta ?? null;
      const card = posterCard(t, { onOpen: () => this.onOpenTitle(this.titles.get(t.key) ?? t) });
      const fill = (meta) => {
        if (meta) t.meta = meta;
        fillCard(card, t);
        card.querySelector('.card-sub').textContent = t.note;
        if (t.progress !== null) card.querySelector('.poster').append(h('span.card-progress', null, h('span', { style: { width: `${Math.round(t.progress * 100)}%` } })));
      };
      fill(known);
      if (!known) this.api.lookupRelease(t.release).then((meta) => meta && fill(meta), () => {});
      return card;
    });
    replace(this.continueEl, h('section.browse-row', { 'aria-label': 'Continue watching' }, h('h2', null, 'Continue watching'), h('div.row-scroller', null, h('ul.poster-row', { role: 'list', dataset: { row: 'continue' } }, cards))));
  }

  hide() {
    this.api.browseVisible(false).catch(() => {});
  }

  async load({ refresh = false } = {}) {
    this.loading = true;
    if (!this.view) replace(this.status, h('span.pending', null, h('span.pulse'), 'Reading the swarm for the best-seeded films and series…'));
    try {
      const view = await this.api.browseRows({ refresh });
      this.setRows(view);
    } catch (err) {
      replace(this.status, h('span.error', null, err.message));
      this.onError(err);
    } finally {
      this.loading = false;
    }
  }

  setRows(view) {
    this.view = view;
    this.titles.clear();
    for (const row of view.rows) for (const t of row.items) this.titles.set(t.key, t);
    if (view.hero) this.titles.set(view.hero.key, view.hero);
    this.renderAll();
  }

  /** Information arrived for a title: update its cards and the hero. */
  handleMeta({ key, meta }) {
    const t = this.titles.get(key);
    if (!t) return;
    t.meta = meta;
    for (const card of this.cards.get(key) ?? []) fillCard(card, t);
    if (this.view?.hero?.key === key) this.renderHero(t);
  }

  /** Every torrent of every title on the page (other copies to switch to). */
  knownTorrents() {
    return [...this.titles.values()].flatMap((t) => t.torrents ?? []);
  }

  /** Every title on the page (a title page's "More like this"). */
  allTitles() {
    return [...this.titles.values()];
  }

  /**
   * The hero's best torrent is fetched before Play is pressed once Browse has been on screen a
   * moment (not on every flick past), as search does for its best pick, and off with the same
   * setting.
   */
  scheduleHeroPreload(t) {
    clearTimeout(this.heroTimer);
    this.heroTimer = setTimeout(() => {
      const best = (this.titles.get(t.key) ?? t).best;
      if (this.root.offsetParent !== null && this.view?.hero?.key === t.key && best?.link) {
        this.api.preloadBest({ link: best.link, infoHash: best.infoHash ?? null }).catch(() => {});
      }
    }, HERO_PRELOAD_DELAY_MS);
  }

  renderAll() {
    const v = this.view;
    clear(this.status);
    this.cards.clear();
    if (v.disabled) {
      clear(this.hero);
      return replace(this.rowsEl, h('p.empty', { style: { padding: '2rem' } }, 'Browse is off. Turn it on in Settings → Browse.'));
    }
    if (v.rows.length === 0) {
      clear(this.hero);
      return replace(this.rowsEl, h('p.empty', { style: { padding: '2rem' } }, v.error ? `Nothing to show: ${v.error}` : 'Nothing to show yet.'));
    }
    if (v.hero) {
      this.renderHero(this.titles.get(v.hero.key) ?? v.hero);
      this.scheduleHeroPreload(v.hero);
    } else clear(this.hero);
    replace(
      this.rowsEl,
      v.rows.map((row) => this.renderRow(row)),
      h(
        'p.browse-foot',
        null,
        `Rankings come from seeders on the public index${v.fetchedAt ? `, read ${timeAgo(v.fetchedAt)}` : ''}. Posters and information from Wikipedia, Wikidata and TVmaze. `,
        h('button.linkish', { type: 'button', onclick: () => this.load({ refresh: true }) }, 'Refresh'),
        v.error ? h('span.error', null, ` · ${v.error}`) : null,
      ),
    );
  }

  renderHero(t) {
    const image = t.meta?.backdrop ?? t.meta?.image ?? t.meta?.poster ?? null;
    const back = h('div.hero-back');
    if (image) back.style.backgroundImage = `url("${image.replace(/["\\]/g, '')}")`;
    replace(
      this.hero,
      back,
      h('div.hero-shade'),
      h(
        'div.hero-body',
        null,
        h('p.eyebrow', null, t.kind === 'tv' ? 'Top series on the swarm' : 'Top film on the swarm'),
        h('h1', null, t.meta?.title ?? t.title),
        h('p.hero-meta', null, metaLine(t)),
        t.meta?.overview ? h('p.hero-overview', null, t.meta.overview) : null,
        h(
          'div.hero-actions',
          null,
          t.best ? h('button.btn.primary', { type: 'button', dataset: { key: 'hero-play', autofocus: '' }, onclick: () => this.onPlay(t.best, t) }, icon(ICONS.play, { size: 16, cls: 'fill' }), 'Play') : null,
          h('button.btn', { type: 'button', dataset: { key: 'hero-info' }, onclick: () => this.onOpenTitle(this.titles.get(t.key) ?? t) }, icon(ICONS.info, { size: 16 }), 'More info'),
          h('button.btn.secondary', { type: 'button', dataset: { key: 'hero-search' }, onclick: () => this.onSearch(searchQuery(t)) }, 'Search'),
        ),
      ),
    );
  }

  renderRow(row) {
    // The two top rows rank their first ten, as a streaming service's "Top 10" does.
    const ranked = row.id === 'top-films' || row.id === 'top-series';
    const list = h(
      'ul.poster-row',
      { role: 'list', dataset: { row: row.id } },
      row.items.map((t, i) => {
        const card = this.renderCard(this.titles.get(t.key) ?? t);
        if (ranked && i < TOP_RANKS) rankCard(card, i + 1);
        return card;
      }),
    );
    const scroll = (dir) => list.scrollBy({ left: dir * list.clientWidth * SCROLL_STEP, behavior: 'smooth' });
    return h(
      'section.browse-row',
      { 'aria-label': row.title },
      h('h2', null, row.title, h('span.count', null, ` ${row.items.length}`)),
      h(
        'div.row-scroller',
        null,
        h('button.scroll-btn.left', { type: 'button', 'aria-label': 'Scroll left', onclick: () => scroll(-1) }, icon(ICONS.chevronLeft, { size: 22 })),
        list,
        h('button.scroll-btn.right', { type: 'button', 'aria-label': 'Scroll right', onclick: () => scroll(1) }, icon(ICONS.chevronRight, { size: 22 })),
      ),
    );
  }

  renderCard(t) {
    const card = posterCard(t, { onOpen: () => this.onOpenTitle(this.titles.get(t.key) ?? t) });
    if (!this.cards.has(t.key)) this.cards.set(t.key, []);
    this.cards.get(t.key).push(card);
    return card;
  }
}

function metaLine(t) {
  const bits = [];
  if (t.year) bits.push(String(t.year));
  bits.push(t.kind === 'tv' ? 'Series' : 'Film');
  if (t.meta?.rating) bits.push(`★ ${t.meta.rating.toFixed(1)}`);
  if (t.meta?.genres?.length) bits.push(t.meta.genres.slice(0, 3).join(', '));
  if (t.seeders !== null && t.seeders !== undefined) bits.push(`${t.seeders} seeders`);
  if (t.best?.quality?.label) bits.push(t.best.quality.label);
  return bits.join(' · ');
}

/** What to search the index for to find a title's copies. */
export function searchQuery(t) {
  return t.kind === 'movie' && t.year ? `${t.title} ${t.year}` : t.title;
}

function timeAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

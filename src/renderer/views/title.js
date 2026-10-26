// SPDX-License-Identifier: MIT OR Apache-2.0
//
// A title's own page: a film or a series, opened from a Browse card, a search result or another
// title. It shows what is known at once and fills in as more arrives (the information, every
// copy the swarm has, for a series its seasons and episodes), offers Resume and Play from start
// when it was watched before, and gets its first choice ready to play as it opens, so Play
// starts at once. Below: the films before and after it, and more like it on the swarm.
//
// It is drawn once per title and then filled in place: on a TV, a control redrawn under the
// remote's focus would leave it on nothing (see lib/tv.js).

import { h, icon, ICONS, replace } from '../lib/dom.js';
import { toast } from '../lib/toast.js';
import { titleKey } from '../../shared/release.js';
import { formatTime, plural } from '../../shared/format.js';
import { pickable } from '../../shared/quality.js';
import { episodeLabel } from '../../shared/episodes.js';
import { posterCard, fillCard, torrentLine, hueOf } from './poster-card.js';
import { titleActions } from '../lib/title-actions.js';
import { searchQuery } from './browse.js';

const LIKE_COUNT = 12;
const SUMMARY_CHARS = 160;

/** Genres compared across sources ("Science-Fiction", "Science fiction"). */
const genreKey = (g) => String(g ?? '').toLowerCase().replace(/[^a-z]/g, '');

export class TitleView {
  constructor(root, { api, onPlay, onSearch, onOpenTitle, browseTitles, onError }) {
    this.root = root;
    this.api = api;
    this.onPlay = onPlay;
    this.onSearch = onSearch;
    this.onOpenTitle = onOpenTitle;
    this.browseTitles = browseTitles;
    this.onError = onError;
    /** The title on the page, with what is known of it (see `show`). */
    this.page = null;
    this.gen = 0;
  }

  /**
   * Shows a title. `entry` is its place in the history (`{ key, kind, title, year, qid? }`);
   * `seed` is what the page that opened it knew (a Browse title, a search result as a title).
   */
  async show(entry, seed = null) {
    if (this.page?.entryKey === entry.key) {
      // Back to the same title (from the player, say): only what was watched may have changed.
      this.#refresh();
      return;
    }
    const gen = ++this.gen;
    let req = entry.qid ? null : { key: entry.key, kind: entry.kind === 'tv' ? 'tv' : 'movie', title: entry.title, year: entry.year ?? null };
    const p = {
      entryKey: entry.key,
      req,
      seed,
      info: seed?.meta ?? null,
      episodes: [],
      torrents: [...(seed?.torrents ?? [])],
      best: seed?.best ?? null,
      seeders: seed?.seeders ?? null,
      progress: null,
      season: null,
      seasonsAsked: new Set(),
      episodeRows: new Map(),
      copyRows: new Map(),
      resolved: new Map(),
      actions: null,
      warmed: null,
      copiesLoading: null,
      els: null,
    };
    this.page = p;
    this.#skeleton(p, entry);
    if (!req) {
      // A related film, known by its Wikidata item: its title and year come first.
      const info = await this.api.titleById(entry.qid).catch(() => null);
      if (gen !== this.gen) return;
      if (!info) {
        p.els.overview.textContent = 'No information found for this title.';
        return;
      }
      req = { key: `movie:${titleKey(info.title)}:${info.year ?? ''}`, kind: 'movie', title: info.title, year: info.year };
      p.req = req;
      p.info = info;
    }
    this.#fillHead();
    this.#fillActions();
    this.api
      .titlePage(req)
      .then((page) => {
        if (gen !== this.gen) return;
        p.progress = page.progress;
        p.info ??= page.info;
        p.seeders ??= page.seeders;
        this.#mergeTorrents(page.torrents);
        this.#fillHead();
        this.#fillActions();
        this.#fillCopies();
      })
      .catch(this.onError);
    this.api
      .titleInfo(req)
      .then(({ info, episodes }) => {
        if (gen !== this.gen) return;
        if (info) p.info = info;
        p.episodes = Array.isArray(episodes) ? episodes : [];
        p.infoDone = true;
        this.#fillHead();
        this.#fillActions();
        this.#fillEpisodes();
        this.#fillRelated();
        this.#fillLike();
        if (!info) p.els.overview.textContent = 'No information found for this title.';
      })
      .catch(() => {
        if (gen !== this.gen) return;
        p.infoDone = true;
        this.#fillActions();
        if (!p.info) p.els.overview.textContent = 'Information could not be fetched just now.';
      });
    p.copiesLoading = this.api
      .titleCopies(req)
      .then(({ torrents }) => {
        if (gen !== this.gen) return;
        this.#mergeTorrents(torrents);
        this.#fillActions();
        this.#fillCopies();
        this.#fillEpisodes();
      })
      .catch(() => {})
      .finally(() => {
        if (gen === this.gen) p.copiesLoading = null;
        if (gen === this.gen) this.#fillCopies();
      });
    this.#fillLike();
  }

  /** Leaving the page: its warm-up stops, unless the viewer is going to play it. */
  hide(dest) {
    const p = this.page;
    if (!p?.req || dest === 'player') return;
    p.warmed = null;
    this.api.coolDownTitle(p.req.key).catch(() => {});
  }

  /** Information Browse found for a title: the page shows it if it had none. */
  handleMeta({ key, meta }) {
    const p = this.page;
    if (!p?.req || p.req.key !== key || p.info) return;
    p.info = meta;
    this.#fillHead();
  }

  /** Every copy on the page (other copies to switch to when one sends nothing). */
  knownTorrents() {
    return this.page?.torrents ?? [];
  }

  /** How getting the first choice ready goes (the preloader's status). */
  setPreload(status) {
    const p = this.page;
    if (!p?.els) return;
    if (!status || status.owner !== p.req?.key) {
      p.els.warm.textContent = '';
      return;
    }
    const peers = status.peers ? ` · ${plural(status.peers, 'peer')}` : '';
    p.els.warm.textContent =
      status.phase === 'ready' ? 'Ready to play.' : status.phase === 'buffering' ? `Getting ready to play… ${Math.round(status.progress * 100)}%${peers}` : status.phase === 'resolving' ? 'Getting ready to play…' : '';
  }

  // ----- drawing -----

  #skeleton(p, entry) {
    const e = {};
    p.els = e;
    e.backdrop = h('div.title-backdrop');
    e.poster = h('div.title-poster');
    e.eyebrow = h('p.eyebrow');
    e.name = h('h1.title-name', null, entry.title ?? '');
    e.chips = h('p.chips');
    e.genres = h('p.chips.genres');
    e.overview = h('p.title-overview', null, 'Looking it up…');
    e.people = h('p.title-people.muted');
    e.reviews = h('p.title-reviews.muted');
    e.primaryLabel = h('span.label', null, 'Play');
    e.primary = h('button.btn.primary', { type: 'button', dataset: { key: 'title-play', autofocus: '' }, onclick: () => this.#press('primary') }, icon(ICONS.play, { size: 16, cls: 'fill' }), e.primaryLabel);
    e.secondaryLabel = h('span.label');
    e.secondary = h('button.btn', { type: 'button', hidden: true, dataset: { key: 'title-play-2' }, onclick: () => this.#press('secondary') }, e.secondaryLabel);
    e.search = h('button.btn.secondary', { type: 'button', dataset: { key: 'title-search' }, onclick: () => this.onSearch(searchQuery(p.req ?? entry)) }, 'Search the index');
    e.linkLabel = h('span.label');
    e.link = h('button.btn.secondary', { type: 'button', hidden: true, dataset: { key: 'title-link' }, onclick: () => p.info?.link && this.api.openLink(p.info.link).catch(this.onError) }, e.linkLabel, ' ', icon(ICONS.external, { size: 12 }));
    e.warm = h('p.warm.muted', { 'aria-live': 'polite' });
    e.credits = h('p.credits.muted');
    e.tabs = h('div.season-tabs', { role: 'tablist', 'aria-label': 'Seasons' });
    e.episodes = h('ul.episode-list');
    e.seasons = h('section.title-section.title-episodes', { hidden: true }, h('h2', null, 'Episodes'), e.tabs, e.episodes);
    e.copiesNote = h('p.muted.copies-note');
    e.copies = h('ul.copy-list');
    e.copiesSection = h('section.title-section', null, h('h2', null, 'Copies on the swarm'), e.copiesNote, e.copies);
    e.relatedRow = h('ul.poster-row', { role: 'list', dataset: { row: 'title-related' } });
    e.related = h('section.title-section', { hidden: true }, h('h2', null, 'Before and after'), e.relatedRow);
    e.likeRow = h('ul.poster-row', { role: 'list', dataset: { row: 'title-like' } });
    e.like = h('section.title-section', { hidden: true }, h('h2', null, 'More like this on the swarm'), e.likeRow);
    replace(
      this.root,
      h(
        'div.title-page',
        null,
        e.backdrop,
        h('div.title-scrim'),
        h(
          'div.title-main',
          null,
          e.poster,
          h('div.title-head', null, e.eyebrow, e.name, e.chips, e.genres, e.overview, e.people, e.reviews, h('div.title-actions', null, e.primary, e.secondary, e.search, e.link), e.warm, e.credits),
        ),
        e.seasons,
        e.copiesSection,
        e.related,
        e.like,
      ),
    );
    this.root.scrollTop = 0;
  }

  #fillHead() {
    const p = this.page;
    const e = p.els;
    const info = p.info;
    const req = p.req;
    const kind = info?.kind ?? req?.kind ?? 'movie';
    const backdrop = info?.backdrop ?? info?.image ?? info?.poster ?? null;
    e.backdrop.style.backgroundImage = backdrop ? `url("${backdrop.replace(/["\\]/g, '')}")` : '';
    e.backdrop.classList.toggle('poster-only', !info?.backdrop);
    const title = info?.title ?? req?.title ?? '';
    if (info?.poster) {
      if (e.poster.querySelector('img')?.getAttribute('src') !== info.poster) replace(e.poster, h('img', { src: info.poster, alt: '' }));
      e.poster.classList.remove('typo');
    } else if (!e.poster.classList.contains('typo') || e.poster.dataset.for !== title) {
      // No poster: the title set in type, in a colour of its own.
      e.poster.classList.add('typo');
      e.poster.dataset.for = title;
      e.poster.style.setProperty('--hue', String(hueOf(req?.key ?? title)));
      replace(e.poster, h('span.typo-title', null, title), h('span.typo-year', null, [req?.year ?? info?.year, kind === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · ')));
    }
    e.eyebrow.textContent = [kind === 'tv' ? 'Series' : 'Film', info?.network, info?.status].filter(Boolean).join(' · ');
    e.name.textContent = title;
    const chips = [];
    const year = info?.year ?? req?.year;
    if (year) chips.push(String(year));
    if (info?.runtimeMins) chips.push(`${info.runtimeMins} min`);
    if (info?.rating) chips.push(`★ ${Number(info.rating).toFixed(1)}`);
    if (info?.seasons?.length) chips.push(plural(info.seasons.length, 'season'));
    if (p.seeders) chips.push(`${p.seeders} seeders`);
    replace(e.chips, chips.map((c) => h('span.chip.static', null, c)));
    replace(e.genres, (info?.genres ?? []).slice(0, 5).map((g) => h('span.chip.static.soft', null, g)));
    if (info) e.overview.textContent = info.overview ?? info.description ?? 'No summary found for this title.';
    const people = [];
    if (info?.directors?.length) people.push(`Directed by ${info.directors.join(', ')}`);
    if (info?.cast?.length) people.push(`With ${info.cast.slice(0, 6).map((c) => (c.character ? `${c.name} (${c.character})` : c.name)).join(', ')}`);
    e.people.textContent = people.join(' · ');
    e.reviews.textContent = (info?.reviews ?? []).map((r) => `${r.source} ${r.text}`).join(' · ');
    e.link.hidden = !info?.link;
    e.linkLabel.textContent = info?.source === 'tvmaze' ? 'TVmaze' : 'Wikipedia';
    e.credits.textContent = (info?.credits ?? []).length > 0 ? `Information: ${info.credits.map((c) => `${c.name} (${c.license})`).join(', ')}.` : '';
  }

  #fillActions() {
    const p = this.page;
    if (!p.req) return;
    const kind = p.info?.kind ?? p.req.kind;
    p.actions = titleActions({ kind, progress: p.progress, best: p.best, episodes: p.episodes });
    const e = p.els;
    e.primaryLabel.textContent = p.actions.primary.play || !p.copiesLoading ? p.actions.primary.label : 'Finding copies…';
    const second = p.actions.secondary;
    if (!second && document.activeElement === e.secondary) e.primary.focus({ preventScroll: true });
    e.secondary.hidden = !second;
    e.secondaryLabel.textContent = second?.label ?? '';
    this.#warm();
  }

  /** Torrents found later join the page's, each once, best seeded first. */
  #mergeTorrents(list) {
    const p = this.page;
    // One torrent listed by several indexers is one copy.
    const id = (t) => t?.infoHash?.toLowerCase() ?? t?.key;
    const seen = new Set(p.torrents.map(id));
    for (const t of list ?? []) if (id(t) && !seen.has(id(t))) (seen.add(id(t)), p.torrents.push(t));
    p.torrents.sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
    // As Browse picks a title's Play: playable first, then the most seeded.
    const videos = p.torrents.filter((t) => t.link && t.quality && t.quality.kind !== 'audio');
    p.best = videos.find((t) => pickable(t)) ?? videos[0] ?? p.best;
  }

  /** The copies of the season on screen (a series), or all of them (a film). */
  #copiesShown() {
    const p = this.page;
    if ((p.info?.kind ?? p.req?.kind) !== 'tv' || p.season === null) return p.torrents;
    return p.torrents.filter((t) => t.season === p.season || (t.season === null && t.episode === null));
  }

  #fillCopies() {
    const p = this.page;
    const e = p.els;
    const shown = this.#copiesShown();
    e.copiesNote.textContent = shown.length === 0 ? (p.copiesLoading ? 'Asking the index…' : 'None found on the public index right now.') : '';
    const focusInside = e.copies.contains(document.activeElement);
    const keys = new Set(shown.map((t) => t.key));
    // Rows only appear or go while the remote is elsewhere; meanwhile new ones are added at the end.
    if (!focusInside) {
      for (const [k, li] of p.copyRows) if (!keys.has(k)) (li.remove(), p.copyRows.delete(k));
    }
    for (const tor of shown) {
      if (p.copyRows.has(tor.key)) continue;
      const li = torrentLine(tor, { onPlay: (t) => this.#play({ kind: 'torrent', torrent: t }) });
      p.copyRows.set(tor.key, li);
      e.copies.append(li);
    }
    if (!focusInside) for (const tor of shown) e.copies.append(p.copyRows.get(tor.key));
  }

  /** Seasons (buttons) and the chosen season's episodes, with what is on the swarm of each. */
  #fillEpisodes() {
    const p = this.page;
    const e = p.els;
    const isTv = (p.info?.kind ?? p.req?.kind) === 'tv';
    const seasons = [...new Set(p.episodes.map((ep) => ep.season))];
    e.seasons.hidden = !isTv || seasons.length === 0;
    if (e.seasons.hidden) return;
    if (p.season === null || !seasons.includes(p.season)) p.season = p.progress?.last?.season ?? seasons[0];
    if (e.tabs.childElementCount !== seasons.length) {
      replace(
        e.tabs,
        seasons.map((n) =>
          h('button.chip.season-tab', { type: 'button', role: 'tab', dataset: { key: `season-${n}`, season: String(n) }, onclick: () => this.#selectSeason(n) }, `Season ${n}`),
        ),
      );
    }
    for (const b of e.tabs.children) {
      const on = Number(b.dataset.season) === p.season;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const list = p.episodes.filter((ep) => ep.season === p.season);
    if (e.episodes.dataset.season !== String(p.season)) {
      e.episodes.dataset.season = String(p.season);
      p.episodeRows.clear();
      replace(e.episodes, list.map((ep) => this.#episodeRow(ep)));
    }
    for (const ep of list) this.#fillEpisodeRow(ep);
    this.#fillCopies();
  }

  #episodeRow(ep) {
    const p = this.page;
    const name = ep.name ?? `Episode ${ep.number}`;
    const row = h(
      'li.episode-row',
      {
        tabindex: '0',
        role: 'button',
        dataset: { key: `ep-${ep.season}-${ep.number}` },
        'aria-label': `${episodeLabel(ep.season, ep.number)}: ${name}`,
        onclick: () => this.#playEpisode(ep.season, ep.number),
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this.#playEpisode(ep.season, ep.number);
          }
        },
      },
      h('div.ep-still', null, ep.still ? h('img', { src: ep.still, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', null, String(ep.number))),
      h(
        'div.ep-text',
        null,
        h('span.ep-title', null, `${ep.number}. ${name}`),
        h('span.ep-meta.muted'),
        ep.summary ? h('span.ep-summary.muted', null, ep.summary.length > SUMMARY_CHARS ? `${ep.summary.slice(0, SUMMARY_CHARS - 1)}…` : ep.summary) : null,
      ),
      h('div.ep-bar', null, h('span')),
    );
    p.episodeRows.set(`S${ep.season}E${ep.number}`, row);
    return row;
  }

  #fillEpisodeRow(ep) {
    const p = this.page;
    const row = p.episodeRows.get(`S${ep.season}E${ep.number}`);
    if (!row) return;
    const own = p.torrents.filter((t) => t.season === ep.season && t.episode === ep.number).length;
    const inPack = p.torrents.some((t) => t.season === ep.season && t.episode === null);
    const watched = p.progress?.episodes?.[`S${ep.season}E${ep.number}`] ?? null;
    const bits = [];
    if (ep.airdate) bits.push(ep.airdate);
    if (ep.runtimeMins) bits.push(`${ep.runtimeMins} min`);
    if (watched?.completed) bits.push('Watched');
    else if (watched?.resumeSecs) bits.push(`Stopped at ${formatTime(watched.resumeSecs)}`);
    if (own > 0) bits.push(`${plural(own, 'copy', 'copies')} on the swarm`);
    else if (inPack) bits.push(`In a season ${ep.season} pack`);
    row.querySelector('.ep-meta').textContent = bits.join(' · ');
    const fraction = watched?.completed ? 1 : watched?.durationSecs ? Math.min(1, (watched.positionSecs ?? 0) / watched.durationSecs) : 0;
    row.querySelector('.ep-bar span').style.width = `${Math.round(fraction * 100)}%`;
    row.classList.toggle('watched', Boolean(watched?.completed));
  }

  #selectSeason(n) {
    const p = this.page;
    if (p.season === n) return;
    p.season = n;
    this.#fillEpisodes();
    // That season's copies (its episodes and packs) from the index, once.
    if (p.seasonsAsked.has(n) || !p.req) return;
    p.seasonsAsked.add(n);
    const gen = this.gen;
    this.api
      .titleCopies(p.req, { season: n })
      .then(({ torrents }) => {
        if (gen !== this.gen) return;
        this.#mergeTorrents(torrents);
        this.#fillEpisodes();
      })
      .catch(() => {});
  }

  /** The films before and after this one, as cards that open their own pages. */
  #fillRelated() {
    const p = this.page;
    const related = p.info?.related ?? [];
    p.els.related.hidden = related.length === 0;
    if (related.length === 0 || p.els.relatedRow.childElementCount > 0) return;
    const gen = this.gen;
    for (const r of related) {
      const t = { key: `wd:${r.qid}`, qid: r.qid, kind: 'movie', title: r.title, year: null, seeders: null, meta: null };
      const card = posterCard(t, { onOpen: () => this.onOpenTitle(t) });
      card.querySelector('.card-sub').textContent = r.relation === 'before' ? 'Before this' : 'After this';
      p.els.relatedRow.append(card);
      // Its poster and year, when known.
      this.api
        .titleById(r.qid)
        .then((info) => {
          if (gen !== this.gen || !info) return;
          t.meta = info;
          t.year = info.year;
          fillCard(card, t);
          card.querySelector('.card-sub').textContent = [r.relation === 'before' ? 'Before this' : 'After this', info.year].filter(Boolean).join(' · ');
        })
        .catch(() => {});
    }
  }

  /** Titles on Browse of the same kind sharing its genres: instant, and every one can play. */
  #fillLike() {
    const p = this.page;
    if (!p.req || p.els.likeRow.contains(document.activeElement)) return;
    const kind = p.info?.kind ?? p.req.kind;
    const mine = new Set((p.info?.genres ?? []).map(genreKey));
    const scored = this.browseTitles()
      .filter((t) => t.key !== p.req.key && t.torrents?.length > 0)
      .map((t) => {
        const shared = (t.meta?.genres ?? []).filter((g) => mine.has(genreKey(g))).length;
        return { t, score: shared * 10 + (t.kind === kind ? 5 : 0) + Math.log10(1 + (t.seeders ?? 0)) };
      })
      .filter((x) => mine.size === 0 || x.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIKE_COUNT);
    p.els.like.hidden = scored.length === 0;
    const signature = scored.map((x) => x.t.key).join('|');
    if (p.els.likeRow.dataset.signature === signature) return;
    p.els.likeRow.dataset.signature = signature;
    replace(p.els.likeRow, scored.map(({ t }) => posterCard(t, { onOpen: () => this.onOpenTitle(t) })));
  }

  // ----- playing -----

  /** What the main buttons play, once it is known (an episode is looked for when pressed). */
  async #press(which) {
    const p = this.page;
    let action = p.actions?.[which];
    if (which === 'primary' && !action?.play && p.copiesLoading) {
      p.els.primaryLabel.textContent = 'Finding copies…';
      await p.copiesLoading;
      action = p.actions?.[which];
    }
    if (!action?.play) {
      toast('No copy of this title is on the swarm right now.', { action: 'Search the index', onAction: () => this.onSearch(searchQuery(p.req)) });
      return;
    }
    this.#play(action.play);
  }

  async #playEpisode(season, episode) {
    const watched = this.page.progress?.episodes?.[`S${season}E${episode}`] ?? null;
    // Watched part of it: on from there (the button beside Resume starts over).
    if (watched?.resumeSecs) return this.#play({ kind: 'episode', season, episode, item: watched, positionSecs: watched.resumeSecs });
    return this.#play({ kind: 'episode', season, episode, item: watched, fromStart: Boolean(watched) });
  }

  /** Which copy plays an episode (its own torrent, a season pack, or one found by searching). */
  async #resolveEpisode(season, episode) {
    const p = this.page;
    const k = `S${season}E${episode}`;
    if (!p.resolved.has(k)) p.resolved.set(k, this.api.titleEpisode(p.req, season, episode).catch(() => null));
    return p.resolved.get(k);
  }

  async #play(play) {
    const p = this.page;
    const start = { positionSecs: play.positionSecs ?? null, fromStart: play.fromStart === true, pick: null };
    if (play.kind === 'torrent') return this.onPlay(torrentSpec(play.torrent), start);
    if (play.item) return this.onPlay(itemSpec(play.item), start);
    if (play.kind === 'episode') {
      const label = episodeLabel(play.season, play.episode);
      const row = p.episodeRows.get(`S${play.season}E${play.episode}`);
      row?.classList.add('busy');
      const found = await this.#resolveEpisode(play.season, play.episode);
      row?.classList.remove('busy');
      if (this.page !== p) return undefined;
      if (!found) {
        toast(`No copy of ${label} is on the swarm right now.`, { action: 'Search the index', onAction: () => this.onSearch(`${p.req.title} S${String(play.season).padStart(2, '0')}E${String(play.episode).padStart(2, '0')}`) });
        return undefined;
      }
      return this.onPlay(found, { ...start, pick: found.pick ?? null });
    }
    return undefined;
  }

  /** Gets the first choice ready to play: its start and end are fetched while the page is read. */
  async #warm() {
    const p = this.page;
    const play = p.actions?.primary.play;
    if (!play || !p.req) return;
    // A series' first choice depends on its episode list: nothing is fetched before it is known.
    if ((p.info?.kind ?? p.req.kind) === 'tv' && !p.infoDone) return;
    let target = null;
    // Resuming: where it was left is fetched too.
    if (play.item) target = { link: play.item.source, infoHash: play.item.infoHash, fileIndex: play.item.fileIndex, pick: null, positionSecs: play.positionSecs ?? null, durationSecs: play.item.durationSecs ?? null };
    else if (play.kind === 'torrent') target = { link: play.torrent.link, infoHash: play.torrent.infoHash ?? null, fileIndex: null, pick: null };
    else if (play.kind === 'episode') {
      const found = await this.#resolveEpisode(play.season, play.episode);
      if (!found || this.page !== p) return;
      target = { link: found.source, infoHash: found.infoHash, fileIndex: found.fileIndex, pick: found.pick ?? null };
    }
    if (!target?.link) return;
    const sig = `${target.infoHash ?? target.link}|${target.fileIndex}|${target.pick ? `${target.pick.season}x${target.pick.episode}` : ''}|${target.positionSecs ?? ''}`;
    if (p.warmed === sig) return;
    p.warmed = sig;
    this.api.warmUpTitle({ title: p.req, ...target }).then((s) => this.setPreload(s), () => {});
  }

  /** Back on the page: what was watched may have changed. */
  #refresh() {
    const p = this.page;
    if (!p?.req) return;
    const gen = this.gen;
    p.warmed = null;
    this.api
      .titlePage(p.req)
      .then((page) => {
        if (gen !== this.gen) return;
        p.progress = page.progress;
        p.resolved.clear();
        this.#fillActions();
        if (p.episodes.length > 0) for (const ep of p.episodes.filter((x) => x.season === p.season)) this.#fillEpisodeRow(ep);
      })
      .catch(() => {});
    this.#fillLike();
  }
}

/** A copy as what plays: the torrent's main video (or, with `pick`, an episode in it). */
function torrentSpec(tor) {
  return { source: tor.link, infoHash: tor.infoHash ?? null, fileIndex: null, title: tor.title, torrentName: tor.title, sizeBytes: tor.sizeBytes ?? null };
}

/** A file watched before as what plays. */
function itemSpec(it) {
  return { source: it.source, infoHash: it.infoHash, fileIndex: it.fileIndex, title: it.title, torrentName: it.torrentName, sizeBytes: it.sizeBytes ?? null };
}


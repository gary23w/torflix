// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Wikidata (public domain, CC0): what a film's article does not say in a form a program can
// read: runtime, genres, cast, directors, review scores, other identifiers, and the films it
// follows, is followed by, belongs to or is based on. Read by item id, many items per request.

import { str } from './util.js';

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/** Items by id (up to 50). Labels fall back to the any-language label: some people have only that. */
export function entitiesUrl(ids, props = 'labels|claims|sitelinks') {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.slice(0, 50).join('|'),
    props,
    languages: 'en|mul',
    languagefallback: '1',
    sitefilter: 'enwiki',
    format: 'json',
  }).toString();
  return url.toString();
}

export const isItemId = (id) => typeof id === 'string' && /^Q\d{1,12}$/.test(id);

/** A property's statements, best rank first; deprecated ones are left out. */
export function statements(entity, pid) {
  const list = Array.isArray(entity?.claims?.[pid]) ? entity.claims[pid] : [];
  const live = list.filter((c) => c?.rank !== 'deprecated' && c?.mainsnak?.snaktype === 'value');
  const preferred = live.filter((c) => c.rank === 'preferred');
  return preferred.length > 0 ? [...preferred, ...live.filter((c) => c.rank !== 'preferred')] : live;
}

const value = (c) => c?.mainsnak?.datavalue?.value;

export function claimIds(entity, pid, max = 20) {
  const ids = [];
  for (const c of statements(entity, pid)) {
    const id = value(c)?.id;
    if (isItemId(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

export function claimString(entity, pid) {
  for (const c of statements(entity, pid)) if (typeof value(c) === 'string') return str(value(c), 200);
  return null;
}

/** The years of a date property (publication dates: festival premieres, then releases). */
export function claimYears(entity, pid) {
  const years = [];
  for (const c of statements(entity, pid)) {
    const m = /^[+-]?(\d{4})-/.exec(value(c)?.time ?? '');
    if (m) years.push(Number(m[1]));
  }
  return years.sort((a, b) => a - b);
}

const MINUTE = 'http://www.wikidata.org/entity/Q7727';
const HOUR = 'http://www.wikidata.org/entity/Q25235';

/** The running time (P2047) in minutes. */
export function runtimeMinutes(entity) {
  for (const c of statements(entity, 'P2047')) {
    const v = value(c);
    const amount = Number(v?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (v.unit === MINUTE) return Math.round(amount);
    if (v.unit === HOUR) return Math.round(amount * 60);
  }
  return null;
}

const REVIEWERS = { Q37312: 'IMDb', Q105584: 'Rotten Tomatoes', Q150248: 'Metacritic' };

/**
 * Review scores (P444, with who gave them in P447): IMDb's "8.4/10", Rotten Tomatoes' "83%"
 * (its average rating is left out), Metacritic's "79/100". One per reviewer, the first given.
 */
export function reviewScores(entity) {
  const out = [];
  for (const c of statements(entity, 'P444')) {
    const text = str(value(c), 20);
    const source = REVIEWERS[c.qualifiers?.P447?.[0]?.datavalue?.value?.id];
    if (!text || !source || out.some((r) => r.source === source)) continue;
    if (source === 'Rotten Tomatoes' && !/%$/.test(text)) continue;
    out.push({ source, text });
  }
  return out;
}

/** A 0–10 rating from the review scores: IMDb's, else Metacritic's. */
export function ratingOf(reviews) {
  const imdb = reviews.find((r) => r.source === 'IMDb');
  const m = imdb && /^(\d+(?:\.\d+)?)\/10$/.exec(imdb.text);
  if (m) return Number(m[1]);
  const meta = reviews.find((r) => r.source === 'Metacritic');
  const n = meta && /^(\d+)\/100$/.exec(meta.text);
  return n ? Math.round(Number(n[1])) / 10 : null;
}

export function labelOf(entity) {
  return str(entity?.labels?.en?.value ?? entity?.labels?.mul?.value ?? Object.values(entity?.labels ?? {})[0]?.value, 300);
}

export function enwikiTitle(entity) {
  return str(entity?.sitelinks?.enwiki?.title, 300);
}

/** Genre items read as genres: "science fiction film" → "Science fiction". */
export function genreName(label) {
  const s = String(label ?? '').replace(/\s+(film|movie|films)$/i, '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : null;
}

/** Everything a film page needs from its item, as ids still to be named. */
export function filmFacts(entity) {
  return {
    wikidata: str(entity?.id, 20),
    imdbId: claimString(entity, 'P345'),
    years: claimYears(entity, 'P577'),
    runtimeMins: runtimeMinutes(entity),
    reviews: reviewScores(entity),
    genres: claimIds(entity, 'P136', 6),
    cast: claimIds(entity, 'P161', 12),
    directors: claimIds(entity, 'P57', 3),
    follows: claimIds(entity, 'P155', 2),
    followedBy: claimIds(entity, 'P156', 2),
    series: claimIds(entity, 'P179', 2),
    basedOn: claimIds(entity, 'P144', 2),
  };
}

/** Every id `filmFacts` holds that needs a name. */
export function idsToName(facts) {
  return [...new Set([...facts.genres, ...facts.cast, ...facts.directors, ...facts.follows, ...facts.followedBy, ...facts.series, ...facts.basedOn])];
}

/** Item id → label, from a wbgetentities answer. */
export function labelsFrom(body) {
  const out = {};
  for (const [id, e] of Object.entries(body?.entities ?? {})) {
    const l = labelOf(e);
    if (l) out[id] = l;
  }
  return out;
}

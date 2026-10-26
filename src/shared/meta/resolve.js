// SPDX-License-Identifier: MIT OR Apache-2.0
//
// From a title as releases name it ("Dune", 2021, a film) to everything a title page shows.
//
//   films:  Wikipedia's article (one search: poster, intro, Wikidata item), then the item's
//           facts from Wikidata, then one request naming them all (genres, cast, directors,
//           the films before and after it)
//   series: TVmaze, by exact name (seasons, cast, artwork); episodes are asked for separately,
//           as they can be many; series TVmaze does not know get Wikipedia's article
//
// Every fetch goes through `get(url)`, which returns parsed JSON, or null for "no such thing",
// and throws a MetaError for anything that may pass. The Torflix metadata service and the
// app's own lookups pass their own.

import { str, titleSlug } from './util.js';
import { filmSearchUrl, seriesSearchUrl, pagesUrl, pagesOf, pickFilmPage, pickSeriesPage, fromPage } from './wikipedia.js';
import { entitiesUrl, filmFacts, idsToName, labelsFrom, genreName, ratingOf, isItemId, enwikiTitle } from './wikidata.js';
import { showSearchUrl, showUrl, episodesUrl, splitCountry, pickShow, showInfo, episodesInfo } from './tvmaze.js';

/** The shape of title information; bumped when it changes, so old cached answers are dropped. */
export const META_VERSION = 1;

/** Title information with every field present. */
function blank(kind) {
  return {
    v: META_VERSION,
    source: null,
    sourceId: null,
    kind,
    title: null,
    year: null,
    overview: null,
    description: null,
    poster: null,
    image: null,
    backdrop: null,
    rating: null,
    reviews: [],
    genres: [],
    type: null,
    network: null,
    runtimeMins: null,
    status: null,
    imdbId: null,
    link: null,
    episode: null,
    cast: [],
    directors: [],
    series: [],
    basedOn: [],
    related: [],
    seasons: [],
    premiered: null,
    ended: null,
    ids: { wikidata: null, tvmaze: null, imdb: null },
    credits: [],
  };
}

const wikipediaCredit = (url) => ({ name: 'Wikipedia', url, license: 'CC BY-SA 4.0' });

/** A film's article and its Wikidata facts, as title information. */
async function filmFromPage(get, page) {
  const base = fromPage(page, 'movie');
  if (!base) return null;
  const info = { ...blank('movie'), ...base, credits: [wikipediaCredit(base.link)] };
  delete info.wikidata;
  info.ids.wikidata = base.wikidata;
  if (!base.wikidata) return info;
  const body = await get(entitiesUrl([base.wikidata], 'claims'));
  const entity = body?.entities?.[base.wikidata];
  if (!entity || 'missing' in entity) return info;
  const facts = filmFacts(entity);
  const toName = idsToName(facts);
  const names = toName.length > 0 ? labelsFrom(await get(entitiesUrl(toName, 'labels'))) : {};
  const named = (ids) => ids.map((id) => names[id]).filter(Boolean);
  info.year = info.year ?? facts.years[0] ?? null;
  info.runtimeMins = facts.runtimeMins;
  info.reviews = facts.reviews;
  info.rating = ratingOf(facts.reviews);
  info.genres = [...new Set(named(facts.genres).map(genreName).filter(Boolean))];
  info.cast = named(facts.cast).map((name) => ({ name, character: null, image: null }));
  info.directors = named(facts.directors);
  info.series = named(facts.series);
  info.basedOn = named(facts.basedOn);
  info.related = [
    ...facts.follows.filter((id) => names[id]).map((qid) => ({ qid, title: names[qid], relation: 'before' })),
    ...facts.followedBy.filter((id) => names[id]).map((qid) => ({ qid, title: names[qid], relation: 'after' })),
  ];
  info.imdbId = facts.imdbId;
  info.ids.imdb = facts.imdbId;
  info.credits.push({ name: 'Wikidata', url: `https://www.wikidata.org/wiki/${base.wikidata}`, license: 'CC0' });
  return info;
}

/** A film by its title and (if known) year, or null when no article is about it. */
export async function resolveFilm(get, { title, year = null }) {
  const want = { title: String(title ?? '').trim(), year: Number.isInteger(year) ? year : null };
  if (want.title.length < 1) return null;
  let page = pickFilmPage(pagesOf(await get(filmSearchUrl(want.title, want.year))), want);
  // The year in the search can push a film released a year off out of the results.
  if (!page && want.year) page = pickFilmPage(pagesOf(await get(filmSearchUrl(want.title, null))), want);
  return page ? filmFromPage(get, page) : null;
}

/** A film by its Wikidata item (a related title), or null. */
export async function filmById(get, qid) {
  if (!isItemId(qid)) return null;
  const body = await get(entitiesUrl([qid], 'sitelinks'));
  const article = enwikiTitle(body?.entities?.[qid]);
  if (!article) return null;
  const page = pagesOf(await get(pagesUrl([article])))[0];
  return page ? filmFromPage(get, page) : null;
}

/** A series by its title (and the year it is from, when a release says), or null. */
export async function resolveShow(get, { title, year = null }) {
  const want = { title: String(title ?? '').trim(), year: Number.isInteger(year) ? year : null };
  if (want.title.length < 1) return null;
  const show = pickShow(await get(showSearchUrl(splitCountry(want.title).title)), want);
  if (show) {
    const raw = await get(showUrl(show.id));
    const info = raw ? showInfo(raw) : null;
    if (info) return { ...blank('tv'), ...info };
  }
  const page = pickSeriesPage(pagesOf(await get(seriesSearchUrl(want.title))), want);
  const base = page ? fromPage(page, 'tv') : null;
  if (!base) return null;
  const info = { ...blank('tv'), ...base, credits: [wikipediaCredit(base.link)] };
  delete info.wikidata;
  info.ids.wikidata = base.wikidata;
  return info;
}

/** A series' episodes, by its TVmaze id. */
export async function showEpisodes(get, tvmazeId) {
  if (!Number.isInteger(tvmazeId) || tvmazeId <= 0) return [];
  return episodesInfo((await get(episodesUrl(tvmazeId))) ?? []);
}

/** A title of any kind: series first when a release does not say (no year, no episode). */
export async function resolveTitle(get, { kind, title, year = null }) {
  if (kind === 'movie') return resolveFilm(get, { title, year });
  if (kind === 'tv') return resolveShow(get, { title, year });
  return (await resolveShow(get, { title, year })) ?? resolveFilm(get, { title, year });
}

/** The Torflix metadata service's address for a title: one address per title, however it is spelled. */
export function servicePath(kind, title, year = null) {
  const slug = titleSlug(title);
  if (!slug) return null;
  return `/v1/${kind === 'tv' ? 'tv' : 'movie'}/${encodeURIComponent(slug)}${Number.isInteger(year) ? `/${year}` : ''}`;
}

export const episodesPath = (tvmazeId) => `/v1/tvmaze/${Number(tvmazeId)}/episodes`;
export const filmByIdPath = (qid) => `/v1/wd/${str(qid, 20)}`;

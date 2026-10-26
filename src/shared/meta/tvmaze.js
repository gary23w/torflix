// SPDX-License-Identifier: MIT OR Apache-2.0
//
// TVmaze: series, with seasons, episodes, cast and artwork, found by exact name (never by a
// fuzzy best guess). The data is CC BY-SA, credited with a link to TVmaze; images are linked
// from TVmaze's own servers.

import { str, num, yearOf, stripHtml, clip, sameName } from './util.js';

export const TVMAZE = 'https://api.tvmaze.com';
export const MAX_EPISODES = 1000;

export const showSearchUrl = (title) => `${TVMAZE}/search/shows?q=${encodeURIComponent(title)}`;
export const showUrl = (id) => `${TVMAZE}/shows/${Number(id)}?embed[]=seasons&embed[]=cast&embed[]=images`;
export const episodesUrl = (id) => `${TVMAZE}/shows/${Number(id)}/episodes`;

/** Normalizes a TVmaze show (from a schedule entry, `/shows/:id`, or a search). */
export function normalizeTvmaze(show, episode = null) {
  if (!show || typeof show !== 'object' || !Number.isInteger(show.id)) return null;
  const title = str(show.name, 300);
  if (!title) return null;
  return {
    source: 'tvmaze',
    sourceId: show.id,
    kind: 'tv',
    title,
    year: yearOf(show.premiered),
    overview: stripHtml(show.summary).slice(0, 2000) || null,
    poster: str(show.image?.medium, 500),
    image: str(show.image?.original, 500),
    rating: num(show.rating?.average),
    genres: (Array.isArray(show.genres) ? show.genres : []).map((g) => str(g, 60)).filter(Boolean),
    type: str(show.type, 40),
    network: str(show.webChannel?.name ?? show.network?.name, 100),
    runtimeMins: num(show.averageRuntime ?? show.runtime),
    status: str(show.status, 60),
    imdbId: str(show.externals?.imdb, 20),
    link: str(show.url, 500),
    episode: episode
      ? { season: num(episode.season), number: num(episode.number), name: str(episode.name, 200), airtime: str(episode.airtime, 10), airdate: str(episode.airdate, 10) }
      : null,
  };
}

const COUNTRIES = { us: 'US', usa: 'US', uk: 'GB', gb: 'GB', au: 'AU', nz: 'NZ', ca: 'CA', ie: 'IE' };

/** A release's title without a trailing country ("The Office US"), and that country. */
export function splitCountry(title) {
  const m = /^(.*\S)\s+\(?(us|usa|uk|gb|au|nz|ca|ie)\)?$/i.exec(String(title ?? '').trim());
  return m ? { title: m[1], country: COUNTRIES[m[2].toLowerCase()] } : { title: String(title ?? '').trim(), country: null };
}

const countryOf = (show) => show?.network?.country?.code ?? show?.webChannel?.country?.code ?? null;

/**
 * The show asked for among search results, or null. Only exact names count; then the country
 * a release names, the year (within one of the premiere), and TVmaze's popularity weight
 * decide between namesakes ("The Office" is a 2005 US show, a 2001 UK one, and more).
 */
export function pickShow(results, want) {
  const { title, country } = splitCountry(want.title);
  const candidates = (Array.isArray(results) ? results : [])
    .map((r) => r?.show)
    .filter((s) => s && Number.isInteger(s.id) && sameName(s.name, title));
  if (candidates.length === 0) return null;
  const score = (s) => {
    let v = num(s.weight) ?? 0;
    if (country && countryOf(s) === country) v += 1000;
    const y = yearOf(s.premiered);
    if (want.year && y) v += Math.abs(y - want.year) <= 1 ? 500 : -200;
    return v;
  };
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/** The artwork of a given type, the main one first, preferring one no wider than `maxWidth`. */
function pickImage(images, type, maxWidth) {
  const list = (Array.isArray(images) ? images : []).filter((i) => i?.type === type && i.resolutions?.original?.url);
  if (list.length === 0) return null;
  list.sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)));
  const fits = list.find((i) => (i.resolutions.original.width ?? 0) <= maxWidth) ?? list[0];
  return str(fits.resolutions.original.url, 500);
}

/** A show from `/shows/:id` with seasons, cast and images embedded, as title information. */
export function showInfo(raw) {
  const t = normalizeTvmaze(raw);
  if (!t) return null;
  const e = raw._embedded ?? {};
  const seasons = (Array.isArray(e.seasons) ? e.seasons : [])
    .filter((s) => Number.isInteger(s?.number) && s.number > 0)
    .map((s) => ({
      number: s.number,
      name: str(s.name, 100),
      episodeCount: num(s.episodeOrder),
      premiereDate: str(s.premiereDate, 10),
      endDate: str(s.endDate, 10),
      poster: str(s.image?.medium, 500),
    }));
  return {
    ...t,
    backdrop: pickImage(e.images, 'background', 2000),
    premiered: str(raw.premiered, 10),
    ended: str(raw.ended, 10),
    ids: { tvmaze: raw.id, imdb: t.imdbId, wikidata: null },
    cast: (Array.isArray(e.cast) ? e.cast : [])
      .slice(0, 12)
      .map((c) => ({ name: str(c?.person?.name, 100) ?? '', character: str(c?.character?.name, 100), image: str(c?.person?.image?.medium, 500) }))
      .filter((c) => c.name),
    seasons,
    credits: [{ name: 'TVmaze', url: t.link ?? 'https://www.tvmaze.com/', license: 'CC BY-SA 4.0' }],
  };
}

/** A show's episodes, in order; specials (no number) are left out, summaries cut short. */
export function episodesInfo(list) {
  return (Array.isArray(list) ? list : [])
    .filter((ep) => Number.isInteger(ep?.season) && Number.isInteger(ep?.number))
    .sort((a, b) => a.season - b.season || a.number - b.number)
    .slice(0, MAX_EPISODES)
    .map((ep) => ({
      season: ep.season,
      number: ep.number,
      name: str(ep.name, 200),
      airdate: str(ep.airdate, 10),
      runtimeMins: num(ep.runtime),
      still: str(ep.image?.medium, 500),
      summary: clip(stripHtml(ep.summary), 280),
    }));
}

/** Whether a show is still on, so its seasons and episodes are kept for a shorter time. */
export const isRunning = (info) => /running|to be determined|in development/i.test(info?.status ?? '');

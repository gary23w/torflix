// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Torflix metadata service's answers (meta/ deploys this on Vercel). Every address names one
// title, so the CDN in front of it keeps one answer per title for every Torflix user: the
// sources behind it are asked once per title and day, not once per viewer.
//
//   GET /v1/movie/<slug>[/<year>]      a film
//   GET /v1/tv/<slug>[/<year>]         a series, with its seasons
//   GET /v1/tvmaze/<id>/episodes       a series' episodes
//   GET /v1/wd/<Q-id>                  a film by its Wikidata item (related titles)
//   GET /v1/health
//
// Answers are `{ v, found, info }` (or `{ v, episodes }`). It keeps nothing: no logs of its
// own, no cookies, nothing but the title asked for.

import { MetaError, slugWords } from './util.js';
import { META_VERSION, resolveFilm, resolveShow, filmById, showEpisodes } from './resolve.js';
import { isRunning } from './tvmaze.js';
import { isItemId } from './wikidata.js';

const DAY = 86_400;
export const CACHE = {
  film: `public, max-age=3600, s-maxage=${7 * DAY}, stale-while-revalidate=${30 * DAY}`,
  running: `public, max-age=3600, s-maxage=${DAY / 2}, stale-while-revalidate=${7 * DAY}`,
  ended: `public, max-age=3600, s-maxage=${14 * DAY}, stale-while-revalidate=${30 * DAY}`,
  missing: `public, max-age=3600, s-maxage=${DAY}`,
  bad: `public, max-age=${DAY}, s-maxage=${DAY}`,
  none: 'no-store',
};

const answer = (status, cacheControl, body) => ({ status, cacheControl, body: { v: META_VERSION, ...body } });
const SLUG = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

function parseYear(text) {
  if (text === undefined) return { ok: true, year: null };
  return /^(18|19|20)\d{2}$/.test(text) ? { ok: true, year: Number(text) } : { ok: false };
}

function titleAnswer(info) {
  if (!info) return answer(404, CACHE.missing, { found: false });
  const cache = info.kind === 'tv' ? (isRunning(info) ? CACHE.running : CACHE.ended) : CACHE.film;
  return answer(200, cache, { found: true, info });
}

/** The answer for a request path, as `{ status, cacheControl, body }`. */
export async function handle(pathname, get) {
  const parts = String(pathname ?? '')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return '\0';
      }
    });
  if (parts[0] !== 'v1' || parts.length < 2) return answer(404, CACHE.bad, { error: 'unknownPath' });
  const [, what, a, b, ...rest] = parts;
  try {
    if (what === 'health' && !a) return answer(200, CACHE.none, { ok: true });
    if ((what === 'movie' || what === 'tv') && a && rest.length === 0) {
      const y = parseYear(b);
      if (!SLUG.test(a) || a.length > 120 || !y.ok) return answer(400, CACHE.bad, { error: 'badRequest' });
      const want = { title: slugWords(a), year: y.year };
      return titleAnswer(what === 'movie' ? await resolveFilm(get, want) : await resolveShow(get, want));
    }
    if (what === 'wd' && isItemId(a) && !b) return titleAnswer(await filmById(get, a));
    if (what === 'tvmaze' && /^\d{1,8}$/.test(a ?? '') && b === 'episodes' && rest.length === 0) {
      const episodes = await showEpisodes(get, Number(a));
      return answer(200, episodes.length > 0 ? CACHE.running : CACHE.missing, { episodes });
    }
    return answer(404, CACHE.bad, { error: 'unknownPath' });
  } catch (err) {
    // A source that is down or busy: said plainly, and never cached.
    if (err instanceof MetaError) return answer(503, CACHE.none, { error: err.kind, message: err.message });
    throw err;
  }
}

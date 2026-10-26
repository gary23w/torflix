// SPDX-License-Identifier: MIT OR Apache-2.0
//
// English Wikipedia: for a film, the article (found by one search that also brings each
// candidate's short description, lead image, intro and Wikidata item), whose lead image is
// usually the poster and whose intro is the overview. The text is CC BY-SA, credited with a
// link to the article.

import { str, num, clip, cleanImage, sameName } from './util.js';

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';

/** What each page in a search or title query comes back with. */
const PAGE_PROPS = {
  prop: 'pageimages|description|pageprops|extracts',
  piprop: 'thumbnail|original',
  pithumbsize: '500',
  // Film posters are non-free files: without this, Wikipedia leaves them out.
  pilicense: 'any',
  ppprop: 'wikibase_item|disambiguation',
  exintro: '1',
  explaintext: '1',
  exsentences: '4',
  redirects: '1',
};

function apiUrl(params) {
  const url = new URL(WIKI_API);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString();
  return url.toString();
}

/** A search for a film's article, with everything needed to choose one. */
export function filmSearchUrl(title, year) {
  return apiUrl({ generator: 'search', gsrsearch: [title, year, 'film'].filter(Boolean).join(' '), gsrlimit: '6', gsrnamespace: '0', exlimit: '6', ...PAGE_PROPS });
}

/** A search for a series' article (for series TVmaze does not know). */
export function seriesSearchUrl(title) {
  return apiUrl({ generator: 'search', gsrsearch: `${title} TV series`, gsrlimit: '4', gsrnamespace: '0', exlimit: '4', ...PAGE_PROPS });
}

/** Articles by title (up to 50), with the same fields. */
export function pagesUrl(titles) {
  return apiUrl({ titles: titles.join('|'), exlimit: String(Math.min(titles.length, 20)), ...PAGE_PROPS });
}

/** The pages of a query answer, in search order. */
export function pagesOf(body) {
  const pages = Array.isArray(body?.query?.pages) ? body.query.pages : [];
  return pages.filter((p) => p && !p.missing && !p.invalid).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

const FILM_WORDS = /\bfilm\b|\bmovie\b|\bdocumentary\b|\banime\b/;
const NOT_A_FILM = /\bsoundtrack|\balbum\b|\bnovel\b|\bfranchise\b|\bfilm series\b|\bcharacter\b|\bvideo game\b|\bactor\b|\bactress\b|\bdirector\b|\bsong\b/;
const SERIES_WORDS = /\bseries\b|\btelevision\b|\bsitcom\b|\bminiseries\b|\banime\b|\bshow\b/;

/** An article's title without its "(2021 film)" disambiguator, and that disambiguator's year. */
export function splitTitle(pageTitle) {
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(String(pageTitle ?? ''));
  if (!m || !/\b(film|movie|series|TV|miniseries|documentary)\b/i.test(m[2])) return { name: String(pageTitle ?? ''), year: null };
  const y = /\b(18|19|20)\d{2}\b/.exec(m[2]);
  return { name: m[1], year: y ? Number(y[0]) : null };
}

/** The year an article gives first: its disambiguator, else the first year in its opening sentence. */
function pageYear(page) {
  const fromTitle = splitTitle(page.title).year;
  if (fromTitle) return fromTitle;
  const first = String(page.extract ?? '').split(/(?<=\.)\s/)[0];
  const y = /\b(18|19|20)\d{2}\b/.exec(`${first} ${page.description ?? ''}`);
  return y ? Number(y[0]) : null;
}

/**
 * The article about the film asked for, or null. Its title must be the film's title (never a
 * longer one: "Dune" is not "Dune: Part Three"), its description or intro must say it is a
 * film, and with a year it must be within one of it (releases are dated by their premiere or
 * by their wide release).
 */
export function pickFilmPage(pages, want) {
  for (const page of pages) {
    if (page.pageprops && 'disambiguation' in page.pageprops) continue;
    const description = String(page.description ?? '').toLowerCase();
    const text = `${description} ${String(page.extract ?? '').slice(0, 300).toLowerCase()}`;
    if (!FILM_WORDS.test(text) || NOT_A_FILM.test(description)) continue;
    if (!sameName(splitTitle(page.title).name, want.title)) continue;
    if (want.year) {
      const y = pageYear(page);
      if (!y || Math.abs(y - want.year) > 1) continue;
    }
    return page;
  }
  return null;
}

/** The same for a series article. */
export function pickSeriesPage(pages, want) {
  for (const page of pages) {
    if (page.pageprops && 'disambiguation' in page.pageprops) continue;
    const text = `${page.description ?? ''} ${String(page.extract ?? '').slice(0, 300)}`.toLowerCase();
    if (!SERIES_WORDS.test(text) || !sameName(splitTitle(page.title).name, want.title)) continue;
    return page;
  }
  return null;
}

/** A Wikipedia article as title information (the parts Wikipedia has). */
export function fromPage(page, kind) {
  const title = str(page?.title, 300);
  if (!title) return null;
  return {
    source: 'wikipedia',
    sourceId: str(page.pageprops?.wikibase_item, 20) ?? (page.pageid ? String(page.pageid) : null),
    kind,
    title: splitTitle(title).name,
    year: pageYear(page),
    overview: clip(page.extract, 1200),
    description: str(page.description, 200),
    poster: cleanImage(page.thumbnail?.source),
    image: cleanImage(page.original?.source) ?? cleanImage(page.thumbnail?.source),
    link: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    wikidata: str(page.pageprops?.wikibase_item, 20),
  };
}

/** Normalizes a REST page summary (the older lookup; kept for search-result posters). */
export function normalizeWikipedia(summary, kind) {
  if (!summary || typeof summary !== 'object') return null;
  const title = str(summary.title, 300);
  if (!title || summary.type === 'disambiguation') return null;
  return {
    source: 'wikipedia',
    sourceId: str(summary.pageid ? String(summary.pageid) : null, 20),
    kind,
    title: title.replace(/\s*\((?:\d{4}\s+)?(?:film|TV series|television series|miniseries)\)$/i, ''),
    year: num(Number(/\b(19|20)\d{2}\b/.exec(`${summary.description ?? ''} ${String(summary.extract ?? '').split(/(?<=\.)\s/)[0]}`)?.[0]) || null),
    overview: str(summary.extract, 2000),
    description: str(summary.description, 200),
    poster: str(summary.thumbnail?.source, 800),
    image: str(summary.originalimage?.source, 800),
    rating: null,
    genres: [],
    type: null,
    network: null,
    runtimeMins: null,
    status: null,
    imdbId: null,
    link: str(summary.content_urls?.desktop?.page, 500),
    episode: null,
  };
}

/** Whether a page summary is about the film or series asked for, not a namesake. */
export function wikipediaMatches(summary, parsed) {
  const desc = `${summary?.description ?? ''} ${(summary?.extract ?? '').slice(0, 300)}`.toLowerCase();
  if (parsed.kind === 'movie') {
    if (!FILM_WORDS.test(desc)) return false;
    if (parsed.year && !desc.includes(String(parsed.year)) && !desc.includes(String(parsed.year - 1)) && !desc.includes(String(parsed.year + 1))) return false;
    return true;
  }
  if (parsed.kind === 'tv') return SERIES_WORDS.test(desc);
  return /\bfilm\b|\bmovie\b|\bseries\b|\btelevision\b|\banime\b|\bdocumentary\b/.test(desc);
}

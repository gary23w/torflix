// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The torrent indexes Torflix searches, asked directly from this device: no service sits in
// between, so search works for as long as the indexes do. Each source turns a query and the
// categories asked for into one request, and its answer into results of one shape, the fields
// search.js reads:
//
//   { title, size, seeders, peers, infohash, magnet, download, details, tracker, categories, published }
//
// with Torznab category numbers (2000 films, 5000 TV, 5070 anime, 6000 adult, ...), whatever
// numbering the index itself uses.
//
//   knaben        api.knaben.org: one JSON API over many trackers' listings (The Pirate Bay,
//                 1337x, Nyaa and more), refreshed continuously.
//   thepiratebay  apibay.org: The Pirate Bay's own JSON API, for its live seeder counts.
//
// Both are asked gently: search.js keeps finished searches for ten minutes and spaces the
// requests to one host.

export const SOURCE_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const str = (v, max = 2048) => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null);
const https = (v) => {
  const s = str(v);
  return s && /^https:\/\//i.test(s) ? s : null;
};
const HASH = /^[0-9a-f]{40}$/i;

/**
 * Whether a result's categories are among those asked for. A top-level number asked for (5000)
 * takes its whole family (5040, 5070); a narrower one (3030) only itself. Nothing asked: all.
 */
export function wanted(resultCategories, asked) {
  if (asked.length === 0) return true;
  return resultCategories.some((r) => asked.some((a) => a === r || (a % 1000 === 0 && Math.floor(r / 1000) === a / 1000)));
}

/** GETs or POSTs JSON with the source's timeout, Torflix's User-Agent and a size limit. */
async function fetchJson(url, { method = 'GET', body, userAgent, signal, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(url, {
    method,
    headers: { Accept: 'application/json', 'User-Agent': userAgent, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]) : AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${new URL(url).host} sent too much`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} sent something that is not JSON`);
  }
}

// ----- Knaben -----

/** Knaben's top-level categories (by their millions digit) as Torznab numbers. */
const KNABEN_TOP = { 1: 3000, 2: 5000, 3: 2000, 4: 4000, 5: 6000, 6: 5070, 7: 1000, 8: 4000, 9: 7000, 10: 8000 };

/**
 * Knaben category ids as Torznab numbers. Adult wins over anything else a listing is also filed
 * under, and anime is TV (5070), never a film: Nyaa's episodes are filed under Movies too.
 */
export function knabenCategories(ids) {
  const list = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n) && n > 0) : [];
  const tops = new Set(list.map((id) => Math.floor(id / 1_000_000)));
  if (tops.has(5)) return [6000];
  if (tops.has(6)) return [5070];
  const out = new Set();
  for (const id of list) {
    if (id === 1_003_000) out.add(3030);
    const t = KNABEN_TOP[Math.floor(id / 1_000_000)];
    if (t) out.add(t);
  }
  return [...out];
}

/** Torznab numbers asked for, as the Knaben categories to search (none: all of them). */
export function knabenFilter(asked) {
  const out = new Set();
  for (const c of asked) {
    const top = Math.floor(c / 1000);
    if (c === 3030) out.add(1_003_000);
    else if (top === 2) out.add(3_000_000);
    else if (top === 5) {
      out.add(2_000_000);
      out.add(6_000_000);
    } else if (top === 3) out.add(1_000_000);
    else if (top === 4) {
      out.add(4_000_000);
      out.add(8_000_000);
    } else if (top === 1) out.add(7_000_000);
    else if (top === 6) out.add(5_000_000);
    else if (top === 7) out.add(9_000_000);
    else if (top === 8) out.add(10_000_000);
  }
  return [...out];
}

/** One Knaben hit as a result, or null when it cannot be used. */
export function fromKnaben(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const title = str(hit.title, 1024);
  const hash = str(hit.hash, 40);
  const magnet = str(hit.magnetUrl, 8192);
  const download = https(hit.link);
  if (!title || (!(hash && HASH.test(hash)) && !(magnet && /^magnet:\?/i.test(magnet)) && !download)) return null;
  return {
    title,
    size: num(hit.bytes),
    seeders: num(hit.seeders),
    peers: num(hit.peers),
    infohash: hash && HASH.test(hash) ? hash.toLowerCase() : null,
    magnet: magnet && /^magnet:\?/i.test(magnet) ? magnet : null,
    download,
    details: https(hit.details),
    tracker: str(hit.tracker, 100) ?? str(hit.cachedOrigin, 100) ?? 'Knaben',
    categories: knabenCategories(hit.categoryId),
    published: str(hit.date, 64),
  };
}

async function knaben({ query, categories, limit, hideAdult, userAgent, signal, fetchImpl }) {
  const filter = knabenFilter(categories);
  const body = {
    search_type: '100%',
    search_field: 'title',
    query,
    order_by: 'seeders',
    order_direction: 'desc',
    from: 0,
    size: Math.min(Math.max(limit, 1), 300),
    hide_unsafe: true,
    hide_xxx: hideAdult,
    ...(filter.length > 0 ? { categories: filter } : {}),
  };
  const answer = await fetchJson('https://api.knaben.org/v1', { method: 'POST', body, userAgent, signal, fetchImpl });
  const hits = Array.isArray(answer?.hits) ? answer.hits : [];
  return hits.map(fromKnaben).filter((r) => r && wanted(r.categories, categories));
}

// ----- The Pirate Bay -----

const TPB_FILMS = [201, 202, 207, 209, 210, 211];
const TPB_TV = [205, 208, 212];

/** A Pirate Bay category as Torznab numbers. */
export function tpbCategories(category) {
  const n = Number(category);
  if (!Number.isInteger(n)) return [8000];
  const top = Math.floor(n / 100);
  if (top === 2) return TPB_TV.includes(n) ? [5000] : TPB_FILMS.includes(n) ? [2000] : n === 203 ? [3020] : [8000];
  if (top === 1) return n === 102 ? [3030] : [3000];
  if (top === 3) return [4000];
  if (top === 4) return [1000];
  if (top === 5) return [6000];
  if (top === 6) return n === 601 ? [7020] : n === 602 ? [7030] : [8000];
  return [8000];
}

/** Torznab numbers asked for, as the Pirate Bay's `cat` list (empty: every category). */
export function tpbFilter(asked) {
  const out = new Set();
  for (const c of asked) {
    const top = Math.floor(c / 1000);
    if (c === 3030) out.add(102);
    else if (top === 2) TPB_FILMS.forEach((x) => out.add(x));
    else if (top === 5) TPB_TV.forEach((x) => out.add(x));
    else if (top === 3) out.add(100);
    else if (top === 4) out.add(300);
    else if (top === 1) out.add(400);
    else if (top === 6) out.add(500);
    else if (top === 7) [601, 602].forEach((x) => out.add(x));
    else if (top === 8) out.add(600);
  }
  return [...out];
}

/** One Pirate Bay listing as a result, or null (its "No results returned" row among them). */
export function fromTpb(row) {
  if (!row || typeof row !== 'object' || String(row.id) === '0') return null;
  const title = str(row.name, 1024);
  const hash = str(row.info_hash, 40);
  if (!title || !hash || !HASH.test(hash) || /^0+$/.test(hash)) return null;
  const added = num(row.added);
  return {
    title,
    size: num(row.size),
    seeders: num(row.seeders),
    peers: num(row.leechers),
    infohash: hash.toLowerCase(),
    magnet: null,
    download: null,
    details: /^\d+$/.test(String(row.id)) ? `https://thepiratebay.org/description.php?id=${row.id}` : null,
    tracker: 'The Pirate Bay',
    categories: tpbCategories(row.category),
    published: added ? new Date(added * 1000).toISOString() : null,
  };
}

async function thepiratebay({ query, categories, limit, userAgent, signal, fetchImpl }) {
  const url = new URL('https://apibay.org/q.php');
  url.searchParams.set('q', query);
  const cats = tpbFilter(categories);
  if (cats.length > 0) url.searchParams.set('cat', cats.join(','));
  const rows = await fetchJson(url.href, { userAgent, signal, fetchImpl });
  return (Array.isArray(rows) ? rows : [])
    .map(fromTpb)
    .filter((r) => r && wanted(r.categories, categories))
    .slice(0, limit);
}

/** The sources a search asks, each `{ id, name, host, search(opts) → results }`. */
export const SOURCES = [
  { id: 'knaben', name: 'Knaben', host: 'api.knaben.org', search: knaben },
  { id: 'thepiratebay', name: 'The Pirate Bay', host: 'apibay.org', search: thepiratebay },
];

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Title information, against answers recorded from Wikipedia, Wikidata and TVmaze
// (test/fixtures/meta-sources.json; Wikidata items cut to the properties used).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveFilm, resolveShow, filmById, showEpisodes, resolveTitle, servicePath } from '../src/shared/meta/resolve.js';
import { handle, CACHE } from '../src/shared/meta/service.js';
import { httpGet } from '../src/shared/meta/http.js';
import { titleSlug, MetaError } from '../src/shared/meta/util.js';
import { reviewScores, runtimeMinutes, statements } from '../src/shared/meta/wikidata.js';
import { pickFilmPage, pagesOf, filmSearchUrl } from '../src/shared/meta/wikipedia.js';
import { splitCountry } from '../src/shared/meta/tvmaze.js';

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/meta-sources.json', import.meta.url), 'utf8'));
const get = async (url) => {
  if (!(url in recorded)) throw new Error(`not recorded: ${url}`);
  return structuredClone(recorded[url]);
};

test('a film is its Wikipedia article plus its Wikidata facts', async () => {
  const dune = await resolveFilm(get, { title: 'dune', year: 2021 });
  assert.equal(dune.title, 'Dune');
  assert.equal(dune.year, 2021);
  assert.equal(dune.kind, 'movie');
  assert.equal(dune.ids.wikidata, 'Q60834962');
  assert.equal(dune.runtimeMins, 155);
  assert.equal(dune.rating, 8);
  assert.ok(dune.genres.includes('Science fiction'));
  assert.deepEqual(dune.directors, ['Denis Villeneuve']);
  assert.equal(dune.cast[0].name, 'Timothée Chalamet');
  assert.deepEqual(dune.related, [{ qid: 'Q109228991', title: 'Dune: Part Two', relation: 'after' }]);
  assert.match(dune.poster, /^https:\/\/upload\.wikimedia\.org\/.*\.jpg$/, 'the tracking query is dropped');
  assert.deepEqual(dune.credits.map((c) => c.name), ['Wikipedia', 'Wikidata']);
  assert.ok(dune.reviews.some((r) => r.source === 'Rotten Tomatoes' && r.text === '83%'));
});

test('only the article about that film counts: not its soundtrack, sequel, or another year', async () => {
  const pages = pagesOf(recorded[filmSearchUrl('dune', 2021)]);
  assert.equal(pickFilmPage(pages, { title: 'Dune', year: 2021 }).title, 'Dune (2021 film)');
  assert.equal(pickFilmPage(pages, { title: 'Dune', year: 1999 }), null);
  const lynch = { title: 'Dune (1984 film)', index: 9, description: 'American space opera by David Lynch', extract: 'Dune is a 1984 American epic space opera film.' };
  assert.equal(pickFilmPage([...pages, lynch], { title: 'Dune', year: 1984 }), lynch, 'the year picks between films of one name');
  assert.equal(pickFilmPage(pages, { title: 'Music of Dune', year: 2021 }), null, 'a soundtrack is not a film');
  assert.equal(pickFilmPage(pages, { title: 'Dune Part Three', year: 2021 }), null, 'a film three years off is another film');
});

test('a title spelled any way finds the same film, and by its Wikidata item too', async () => {
  const two = await resolveFilm(get, { title: 'dune part two', year: 2024 });
  assert.equal(two.title, 'Dune: Part Two');
  assert.deepEqual(two.related.map((r) => r.relation), ['before', 'after']);
  assert.equal((await filmById(get, 'Q109228991')).title, 'Dune: Part Two');
  assert.equal((await resolveFilm(get, { title: 'dune' })).year, 2021, 'without a year, the first article that fits');
  assert.equal(await filmById(get, 'not-an-id'), null);
});

test('a series comes from TVmaze by exact name, with seasons, cast and a backdrop', async () => {
  const s = await resolveShow(get, { title: 'severance' });
  assert.equal(s.title, 'Severance');
  assert.equal(s.ids.tvmaze, 44933);
  assert.equal(s.seasons.length, 3);
  assert.equal(s.seasons[0].episodeCount, 9);
  assert.ok(s.backdrop);
  assert.deepEqual(s.cast[0], { name: 'Adam Scott', character: 'Mark Scout', image: s.cast[0].image });
  assert.equal(s.credits[0].name, 'TVmaze');
});

test('namesakes are told apart by the country a release names, or its year', async () => {
  assert.equal((await resolveShow(get, { title: 'the office us' })).year, 2005);
  assert.equal((await resolveShow(get, { title: 'the office', year: 2001 })).year, 2001);
  assert.deepEqual(splitCountry('The Office UK'), { title: 'The Office', country: 'GB' });
  assert.deepEqual(splitCountry('Fargo'), { title: 'Fargo', country: null });
});

test('a release that does not say is looked up as a series first', async () => {
  const t = await resolveTitle(get, { kind: 'unknown', title: 'breaking bad' });
  assert.equal(t.kind, 'tv');
  assert.equal(t.year, 2008);
});

test('episodes are in order, without specials, with short summaries', async () => {
  const eps = await showEpisodes(get, 44933);
  assert.equal(eps.length, 19);
  assert.deepEqual([eps[0].season, eps[0].number, eps[18].season, eps[18].number], [1, 1, 2, 10]);
  assert.ok(eps.every((e) => !e.summary || e.summary.length <= 281));
  assert.deepEqual(await showEpisodes(get, -1), []);
});

test('every spelling of a title gives the same service address', () => {
  assert.equal(servicePath('movie', 'Dune: Part Two', 2024), '/v1/movie/dune-part-two/2024');
  assert.equal(servicePath('movie', 'Dune Part Two', 2024), '/v1/movie/dune-part-two/2024');
  assert.equal(servicePath('tv', 'Amélie & Friends'), '/v1/tv/amelie-and-friends');
  assert.equal(titleSlug('  ...  '), '');
  assert.equal(servicePath('movie', '!!!', 2020), null);
});

test('the service answers by path, and caches only what will not change soon', async () => {
  const film = await handle('/v1/movie/dune/2021', get);
  assert.equal(film.status, 200);
  assert.equal(film.cacheControl, CACHE.film);
  assert.equal(film.body.found, true);
  assert.equal(film.body.info.title, 'Dune');
  const show = await handle('/v1/tv/severance', get);
  assert.equal(show.cacheControl, CACHE.running, 'a running series is kept for half a day');
  assert.equal((await handle('/v1/tvmaze/44933/episodes', get)).body.episodes.length, 19);
  assert.equal((await handle('/v1/movie/bad slug', get)).status, 400);
  assert.equal((await handle('/v1/movie/dune/21', get)).status, 400);
  assert.equal((await handle('/v1/nothing', get)).status, 404);
  assert.equal((await handle('/v1/health', get)).body.ok, true);
  const empty = async (url) => (url.includes('wikipedia') ? { query: { pages: [] } } : []);
  const missing = await handle('/v1/movie/no-such-film/2020', empty);
  assert.deepEqual([missing.status, missing.cacheControl, missing.body.found], [404, CACHE.missing, false]);
  const down = await handle('/v1/movie/dune/2021', async () => {
    throw new MetaError('rate', 'busy');
  });
  assert.deepEqual([down.status, down.cacheControl, down.body.error], [503, CACHE.none, 'rate'], 'a failure is never cached');
});

test('wikidata: ranks, units and review scores', () => {
  const snak = (value, rank = 'normal', qualifiers) => ({ rank, mainsnak: { snaktype: 'value', datavalue: { value } }, ...(qualifiers ? { qualifiers } : {}) });
  const by = (id) => ({ P447: [{ datavalue: { value: { id } } }] });
  const e = {
    claims: {
      P2047: [snak({ amount: '+2.5', unit: 'http://www.wikidata.org/entity/Q25235' })],
      P444: [snak('7.6/10', 'normal', by('Q105584')), snak('83%', 'normal', by('Q105584')), snak('8.0/10', 'normal', by('Q37312'))],
      P136: [snak({ id: 'Q1' }, 'deprecated'), snak({ id: 'Q2' }), snak({ id: 'Q3' }, 'preferred')],
    },
  };
  assert.equal(runtimeMinutes(e), 150);
  assert.deepEqual(reviewScores(e), [{ source: 'Rotten Tomatoes', text: '83%' }, { source: 'IMDb', text: '8.0/10' }]);
  assert.deepEqual(statements(e, 'P136').map((c) => c.mainsnak.datavalue.value.id), ['Q3', 'Q2']);
});

test('fetching: "no such thing" is null, a busy source is waited out once, the rest is a MetaError', async () => {
  const reply = (status, body = {}, headers = {}) => ({ status, ok: status < 300, headers: new Headers(headers), json: async () => body });
  const seq = (...replies) => {
    const calls = [];
    return { calls, fetchImpl: async (url, init) => (calls.push(init.headers['User-Agent']), replies.shift()) };
  };
  let f = seq(reply(404));
  assert.equal(await httpGet('UA', { fetchImpl: f.fetchImpl })('https://x.test/a'), null);
  assert.deepEqual(f.calls, ['UA']);
  f = seq(reply(429, {}, { 'retry-after': '0.01' }), reply(200, { ok: 1 }));
  assert.deepEqual(await httpGet('UA', { fetchImpl: f.fetchImpl })('https://x.test/a'), { ok: 1 });
  f = seq(reply(429), reply(429));
  await assert.rejects(httpGet('UA', { fetchImpl: f.fetchImpl, maxWaitMs: 1 })('https://x.test/a'), (e) => e instanceof MetaError && e.kind === 'rate');
  f = seq(reply(500));
  await assert.rejects(httpGet('UA', { fetchImpl: f.fetchImpl })('https://x.test/a'), (e) => e.kind === 'http');
  await assert.rejects(
    httpGet('UA', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    })('https://x.test/a'),
    (e) => e.kind === 'network',
  );
});

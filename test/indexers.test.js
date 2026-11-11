// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The torrent indexes, asked directly from the device: what each one's answer becomes, the
// requests sent to them, and search when one or all of them fail. Answers below have the
// shapes the two APIs return (fields cut to what is read).

import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, fromKnaben, fromTpb, knabenCategories, knabenFilter, tpbCategories, tpbFilter, wanted } from '../src/main/indexers.js';
import { SearchService, SearchError, describeError } from '../src/main/search.js';

const HASH_A = 'C39FE3EEFBDB62DA9C27EB6398FF4A7D2E26E7AB';
const HASH_B = '9EE38ECC0105ED61B0EF93A875325AFE784B6FB5';

const knabenHit = (over = {}) => ({
  bytes: 928699593,
  cachedOrigin: 'The Pirate Bay (proxy v2)',
  category: 'Movies / HD',
  categoryId: [3001000, 3000000],
  date: '2010-03-09T03:00:44+00:00',
  details: 'https://knaben.xyz/thepiratebay/description.php?id=5421757',
  hash: HASH_B,
  link: null,
  magnetUrl: `magnet:?xt=urn:btih:${HASH_B}&dn=Big.Buck.Bunny.1080p`,
  peers: 2,
  seeders: 31,
  title: 'Big.Buck.Bunny.1080p.Surround',
  tracker: 'The Pirate Bay',
  ...over,
});

const tpbRow = (over = {}) => ({ id: '5316077', name: 'Big.Buck.Bunny.BDRip.XviD-MEDiC', info_hash: HASH_A, leechers: '1', seeders: '12', size: '183567938', added: '1264712003', category: '207', ...over });

test('a Knaben hit becomes a result with Torznab categories', () => {
  const r = fromKnaben(knabenHit());
  assert.equal(r.title, 'Big.Buck.Bunny.1080p.Surround');
  assert.equal(r.infohash, HASH_B.toLowerCase());
  assert.equal(r.size, 928699593);
  assert.equal(r.seeders, 31);
  assert.match(r.magnet, /^magnet:\?xt=urn:btih:/);
  assert.equal(r.tracker, 'The Pirate Bay', 'the tracker it was listed on, not Knaben');
  assert.deepEqual(r.categories, [2000]);
  assert.equal(fromKnaben(knabenHit({ hash: null, magnetUrl: null, link: null })), null, 'no way to get the torrent');
  assert.equal(fromKnaben(knabenHit({ hash: null, magnetUrl: null, link: 'https://knaben.eu/live/dl/1337x/?path=x' })).download, 'https://knaben.eu/live/dl/1337x/?path=x');
  assert.equal(fromKnaben(knabenHit({ title: ' ' })), null);
});

test("Knaben's categories: anime is TV and never a film, adult wins over everything", () => {
  assert.deepEqual(knabenCategories([6001000, 6000000, 3008000, 3000000]), [5070], 'Nyaa episodes are filed under Movies too');
  assert.deepEqual(knabenCategories([3001000, 5001000]), [6000]);
  assert.deepEqual(knabenCategories([2001000, 2000000]), [5000]);
  assert.deepEqual(knabenCategories([1003000, 1000000]).sort(), [3000, 3030]);
  assert.deepEqual(knabenFilter([2000]), [3000000]);
  assert.deepEqual(knabenFilter([5000]).sort(), [2000000, 6000000]);
  assert.deepEqual(knabenFilter([3030]), [1003000]);
  assert.deepEqual(knabenFilter([]), [], 'nothing asked: every category');
});

test('a Pirate Bay listing becomes a result; its empty answer is no result', () => {
  const r = fromTpb(tpbRow());
  assert.equal(r.infohash, HASH_A.toLowerCase());
  assert.equal(r.seeders, 12);
  assert.equal(r.peers, 1);
  assert.equal(r.size, 183567938);
  assert.deepEqual(r.categories, [2000]);
  assert.equal(r.published, '2010-01-28T20:53:23.000Z');
  assert.equal(r.details, 'https://thepiratebay.org/description.php?id=5316077');
  assert.equal(fromTpb({ id: '0', name: 'No results returned', info_hash: '0000000000000000000000000000000000000000', seeders: '0', category: '0' }), null);
  assert.deepEqual(tpbCategories('208'), [5000]);
  assert.deepEqual(tpbCategories('505'), [6000]);
  assert.deepEqual(tpbCategories('102'), [3030]);
  assert.deepEqual(tpbFilter([5000]), [205, 208, 212]);
  assert.deepEqual(tpbFilter([2000]), [201, 202, 207, 209, 210, 211]);
});

test('a category asked for takes its family; a narrower one only itself', () => {
  assert.equal(wanted([5070], [5000]), true);
  assert.equal(wanted([5070], [2000]), false);
  assert.equal(wanted([3000], [3030]), false);
  assert.equal(wanted([3030], [3000]), true);
  assert.equal(wanted([8000], []), true);
});

/** A fetch that answers the two indexes from `answers` (host → body, Error, or 'hang'), recording each request. */
function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    calls.push({ host: u.host, url: u, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers[u.host];
    if (a instanceof Error) throw a;
    if (a === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))));
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(a) };
  };
  return { calls, impl };
}

const settings = { settings: { search: { hideAdult: true, resultsPerSearch: 100 } } };

test('both indexes are asked, with the categories in their own numbers, and one torrent from both is one result', async () => {
  const f = fakeFetch({
    'api.knaben.org': { hits: [knabenHit({ hash: HASH_A, seeders: 40 }), knabenHit({ title: 'Some.Show.S01E01.1080p', hash: HASH_B, categoryId: [6001000, 3000000] })] },
    'apibay.org': [tpbRow({ seeders: '55' })],
  });
  const svc = new SearchService({ settings, version: '9.9.9', platform: 'android-tv', fetchImpl: f.impl });
  const res = await svc.quick('big buck bunny', { categories: [2000] });
  const knaben = f.calls.find((c) => c.host === 'api.knaben.org');
  const tpb = f.calls.find((c) => c.host === 'apibay.org');
  assert.deepEqual(knaben.body.categories, [3000000]);
  assert.equal(knaben.body.query, 'big buck bunny');
  assert.equal(knaben.body.hide_xxx, true);
  assert.equal(knaben.init.method, 'POST');
  assert.equal(tpb.url.searchParams.get('cat'), '201,202,207,209,210,211');
  assert.equal(tpb.url.searchParams.get('q'), 'big buck bunny');
  assert.match(knaben.init.headers['User-Agent'], /^Torflix\/9\.9\.9 \(https:\/\/github\.com\/gary23w\/torflix; android-tv\)$/, 'the same honest User-Agent as title information');
  assert.equal(res.results.length, 1, 'the anime episode is not a film; the shared torrent is one result');
  assert.equal(res.results[0].seeders, 55, 'the higher seeder count of the two');
  assert.deepEqual(res.indexers.map((i) => i.name).sort(), ['Knaben', 'The Pirate Bay']);
});

test('one index failing still gives the other one\'s results, and says which failed', async () => {
  const f = fakeFetch({ 'api.knaben.org': new TypeError('fetch failed'), 'apibay.org': [tpbRow()] });
  const svc = new SearchService({ settings, fetchImpl: f.impl });
  const progress = [];
  svc.setSink((id, p) => progress.push(p));
  svc.start('big buck bunny');
  await new Promise((r) => setTimeout(r, 50));
  const done = progress.at(-1);
  assert.equal(done.done, true);
  assert.equal(done.error, null);
  assert.equal(done.response.results.length, 1);
  assert.equal(done.total, SOURCES.length);
  assert.equal(done.response.indexers.find((i) => i.name === 'Knaben').error, 'The torrent indexes could not be reached. Check your connection.');
});

test('every index failing is one readable error, and nothing is cached', async () => {
  const f = fakeFetch({ 'api.knaben.org': new TypeError('fetch failed'), 'apibay.org': new TypeError('fetch failed') });
  const svc = new SearchService({ settings, fetchImpl: f.impl });
  await assert.rejects(svc.quick('sintel'), (e) => e instanceof SearchError && e.message === 'The torrent indexes could not be reached. Check your connection.');
  assert.equal(describeError(new SearchError('kept as is')), 'kept as is');
  const calls = f.calls.length;
  await assert.rejects(svc.quick('sintel'));
  assert.ok(f.calls.length > calls, 'a failure is asked again, not served from the cache');
});

test('a finished search is kept, and a cancelled one stops asking', async () => {
  const f = fakeFetch({ 'api.knaben.org': { hits: [knabenHit()] }, 'apibay.org': 'hang' });
  const svc = new SearchService({ settings, fetchImpl: f.impl });
  const progress = [];
  svc.setSink((id, p) => progress.push(p));
  svc.start('big buck bunny');
  await new Promise((r) => setTimeout(r, 450));
  svc.cancel();
  const last = progress.at(-1);
  assert.equal(last.done, true);
  assert.equal(last.response.results.length, 1, 'what had come in stays');
});

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Browse and title information when the network or a service lets them down: one bad moment
// must not leave the feed empty (for half an hour, or across a restart), and a failure must be
// reported as what it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Browse } from '../src/main/browse.js';
import { Metadata } from '../src/main/metadata.js';
import { parseQuality } from '../src/shared/quality.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-feed-'));

const result = (title, seeders) => ({
  title,
  key: title,
  link: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
  magnet: null,
  infoHash: null,
  seeders,
  peers: 1,
  sizeBytes: 2e9,
  quality: parseQuality(title, 'Movies', 2e9),
  reason: '',
  indexers: ['x'],
  published: null,
});

/** What the index answers: one film and one series. */
const index = { results: [result('Hope.2026.1080p.WEBRip.x265-NeoNoir', 100), result('Some.Show.S01E02.1080p.WEB', 80)] };

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** A Browse over a fake index; `state.up` says whether the index answers. */
function makeBrowse(dir, state, extra = {}) {
  const settings = { settings: { browse: { fetchInfo: false }, search: { hideAdult: true, resultsPerSearch: 100 } } };
  const search = {
    quick: async () => {
      state.calls = (state.calls ?? 0) + 1;
      if (!state.up) throw timeout();
      return index;
    },
  };
  const metadata = { schedule: async () => [], peek: () => undefined, title: async () => null };
  return new Browse({ dataDir: dir, search, metadata, settings, ...extra });
}

const ids = (view) => view.rows.map((r) => r.id);

test('a build that failed is trusted for a minute, not half an hour', async () => {
  const state = { up: false };
  const browse = makeBrowse(tmp(), state);
  const first = await browse.rows();
  assert.deepEqual(first.rows, []);
  assert.equal(first.error, 'The torrent indexes did not answer in time.', 'the error is readable');
  state.up = true;
  const calls = state.calls;
  assert.deepEqual((await browse.rows()).rows, [], 'inside the minute the failure is shown, not asked again');
  assert.equal(state.calls, calls);
  // A minute later the page asks again, and gets the rows pushed to it.
  browse.cachedRows.checkedAt = browse.cachedRows.fetchedAt = Date.now() - 61_000;
  const pushed = once(browse, 'rows');
  assert.deepEqual((await browse.rows()).rows, [], 'what was there comes back at once');
  const [view] = await pushed;
  assert.equal(view.error, null);
  assert.ok(ids(view).includes('top-films') && ids(view).includes('top-series'));
});

test('rows already read stay when the index fails on a later build', async () => {
  const state = { up: true };
  const browse = makeBrowse(tmp(), state);
  const good = await browse.rows();
  assert.ok(ids(good).includes('top-films'));
  state.up = false;
  const again = await browse.rows({ refresh: true });
  assert.ok(ids(again).includes('top-films'), 'the torrent rows are still there');
  assert.equal(again.error, 'The torrent indexes did not answer in time.');
  assert.equal(again.fetchedAt, good.fetchedAt, 'and still dated by when they were read');
  state.up = true;
  const recovered = await browse.rows({ refresh: true });
  assert.equal(recovered.error, null);
  assert.ok(recovered.fetchedAt >= good.fetchedAt);
});

test('rows saved with an error by an earlier run are asked for again, not trusted for half an hour', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'browse-cache.json'), JSON.stringify({ fetchedAt: Date.now() - 5 * 60_000, error: 'The operation was aborted due to timeout', hero: null, rows: [] }));
  const browse = makeBrowse(dir, { up: true });
  const pushed = once(browse, 'rows');
  const shown = await browse.rows();
  assert.deepEqual(shown.rows, [], 'what was saved shows at once');
  const [view] = await pushed;
  assert.equal(view.error, null);
  assert.ok(ids(view).includes('top-films'));
});

test('a good build is still trusted for half an hour', async () => {
  const state = { up: true };
  const browse = makeBrowse(tmp(), state);
  await browse.rows();
  const calls = state.calls;
  await browse.rows();
  assert.equal(state.calls, calls, 'no new searches');
});

test('on screen after an error, Browse asks again by itself; a retry that fails again stays quiet', async () => {
  const state = { up: false };
  const browse = makeBrowse(tmp(), state, { retryDelaysMs: [20] });
  browse.setVisible(true);
  const first = await browse.rows();
  assert.equal(first.rows.length, 0);
  const events = [];
  browse.on('rows', (v) => events.push(v));
  await sleep(150);
  assert.ok(state.calls > 6, 'it asked again');
  assert.equal(events.length, 0, 'the same failure is not pushed: a redraw would drop the remote\'s focus');
  state.up = true;
  const [view] = await once(browse, 'rows', { signal: AbortSignal.timeout(3000) });
  assert.equal(view.error, null);
  assert.ok(ids(view).includes('top-films'));
  browse.setVisible(false);
});

test('off screen it does not ask again, and does as soon as it is shown', async () => {
  const state = { up: false };
  const browse = makeBrowse(tmp(), state, { retryDelaysMs: [20] });
  await browse.rows();
  const calls = state.calls;
  await sleep(100);
  assert.equal(state.calls, calls, 'nobody is looking: no searches');
  state.up = true;
  const pushed = once(browse, 'rows', { signal: AbortSignal.timeout(3000) });
  browse.setVisible(true);
  const [view] = await pushed;
  assert.ok(ids(view).includes('top-films'));
  browse.setVisible(false);
});

test('the metadata service failing mid-answer is "could not be reached", not "another format"', async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  const settings = { settings: { browse: { fetchInfo: true, metaService: 'https://meta.test' } } };
  const sources = async (url) => ({ status: 200, ok: true, headers: new Headers(), json: async () => (url.includes('wikipedia') ? { query: { pages: [] } } : []) });
  const answer = (text) => async () => ({ status: 200, ok: true, headers: new Headers(), text });
  const cases = [
    ['a body that breaks off', answer(async () => { throw new TypeError('terminated'); }), /could not be reached/],
    ['a body that stalls', answer(async () => { throw timeout(); }), /could not be reached/],
    ['a page that is not JSON', answer(async () => '<html>Sign in</html>'), /not JSON/],
    ['an answer of another version', answer(async () => JSON.stringify({ v: 99, found: false })), /answered in another format/],
    ['an answer of this version', answer(async () => JSON.stringify({ v: 1, found: false })), null],
  ];
  try {
    for (const [name, serve, expected] of cases) {
      warnings.length = 0;
      globalThis.fetch = async (url, init) => (String(url).startsWith('https://meta.test') ? serve(url, init) : sources(String(url)));
      const metadata = new Metadata({ dataDir: tmp(), settings, version: '9.9.9' });
      await metadata.title({ kind: 'movie', title: `Dune ${name}`, year: 2021 });
      if (expected) assert.match(warnings.join('\n'), expected, name);
      else assert.deepEqual(warnings, [], name);
      assert.ok(!(expected && !/another format/.test(expected.source)) || !/another format/.test(warnings.join('\n')), `${name} is not misreported`);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupResults } from '../src/main/browse.js';
import { normalizeWikipedia, wikipediaMatches, normalizeTvmaze } from '../src/main/metadata.js';
import { parseQuality } from '../src/shared/quality.js';

const result = (title, seeders, over = {}) => ({
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
  ...over,
});

test('torrents of the same film are grouped and ranked by seeders', () => {
  const groups = groupResults(
    [
      result('Hope.2026.1080p.WEBRip.x265-NeoNoir', 100),
      result('Hope (2026) [1080p] [WEBRip] [5.1]', 50),
      result('Other.Film.2025.2160p.WEB.x265', 120),
      result('Some.Show.S01E02.1080p.WEB', 999),
      result('Book.Title.2024.epub', 5),
    ],
    'movie',
  );
  assert.deepEqual(groups.map((g) => [g.title, g.seeders]), [['Hope', 150], ['Other Film', 120]]);
  assert.equal(groups[0].torrents.length, 2);
  assert.equal(groups[0].best.seeders, 100);
  assert.equal(groups[0].year, 2026);
});

test('one film spelled several ways is one title', () => {
  const groups = groupResults(
    [
      result('Spider-Man Brand New Day (2026) [1080p] [WEBRip]', 300),
      result('Spider Man Brand New Day 2026 2160p WEB-DL x265', 5000),
      result('Spider-Man.Brand.New.Day.2026.720p.WEBRip.x264', 40),
      result('Spider-Man - Brand New Day - TS', 900),
    ],
    'movie',
  );
  assert.equal(groups.length, 1, 'spellings and the undated copy join one title');
  assert.equal(groups[0].seeders, 6240);
  assert.equal(groups[0].year, 2026);
  assert.equal(groups[0].title, 'Spider Man Brand New Day', 'the most seeded spelling is shown');
  assert.equal(groups[0].best.seeders, 5000);
});

test('an undated copy stays apart when two films share the title', () => {
  const groups = groupResults([result('Dune.1984.1080p.BluRay.x264', 50), result('Dune.2021.1080p.WEB.x264', 900), result('Dune 1080p WEBRip', 30)], 'movie');
  assert.equal(groups.length, 3);
});

test('series groups keep episodes of one show together', () => {
  const groups = groupResults([result('Show.S01E01.1080p.WEB', 10), result('Show.S01E02.1080p.WEB', 20), result('Show.S01.Complete.1080p', 5)], 'tv');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].seeders, 35);
  assert.ok(groups[0].torrents.some((t) => t.episode === null), 'the season pack is there');
});

test('wikipedia matches are checked against the kind and year', () => {
  const film = { title: 'Sintel', description: '2010 film', extract: 'Sintel is a 2010 animated fantasy short film.', thumbnail: { source: 'https://upload.wikimedia.org/x.jpg' }, pageid: 1 };
  assert.equal(wikipediaMatches(film, { title: 'Sintel', year: 2010, kind: 'movie' }), true);
  assert.equal(wikipediaMatches(film, { title: 'Sintel', year: 1999, kind: 'movie' }), false);
  assert.equal(wikipediaMatches({ description: 'Dutch village', extract: 'A village.' }, { title: 'Sintel', year: null, kind: 'movie' }), false);
  const t = normalizeWikipedia(film, 'movie');
  assert.equal(t.title, 'Sintel');
  assert.equal(t.year, 2010);
  assert.equal(t.poster, 'https://upload.wikimedia.org/x.jpg');
  assert.equal(normalizeWikipedia({ title: 'Hope (2026 film)', description: '2026 film', pageid: 2 }, 'movie').title, 'Hope');
});

test('tvmaze shows normalize with their episode', () => {
  const t = normalizeTvmaze({ id: 169, name: 'Breaking Bad', type: 'Scripted', rating: { average: 9.2 }, genres: ['Drama'], image: { medium: 'm.jpg', original: 'o.jpg' }, premiered: '2008-01-20', summary: '<p>A <b>chemistry</b> teacher.</p>' }, { season: 1, number: 2, name: 'Pilot' });
  assert.equal(t.year, 2008);
  assert.equal(t.overview, 'A chemistry teacher.');
  assert.equal(t.episode.number, 2);
  assert.equal(t.rating, 9.2);
});

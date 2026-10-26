// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, titleKey } from '../src/shared/release.js';

test('movie release names give title and year', () => {
  assert.deepEqual(parseRelease('Sintel.2010.1080p.WEB.H264-CLASSiCALHD'), { title: 'Sintel', year: 2010, kind: 'movie', season: null, episode: null });
  assert.deepEqual(parseRelease('Tears of Steel (2012) [1080p] [WEBRip]'), { title: 'Tears of Steel', year: 2012, kind: 'movie', season: null, episode: null });
  assert.equal(parseRelease('Big.Buck.Bunny.2008.1080p.BluRay.x264-YTS').title, 'Big Buck Bunny');
  assert.equal(parseRelease('www.UIndex.org    -    Sintel.2010.1080p.WEB.H264-CLASSiCALHD').title, 'Sintel');
});

test('series release names give season and episode', () => {
  assert.deepEqual(parseRelease('Some.Show.S02E05.720p.WEBRip.x264-GROUP'), { title: 'Some Show', year: null, kind: 'tv', season: 2, episode: 5 });
  assert.deepEqual(parseRelease('Another Show 1x03 HDTV'), { title: 'Another Show', year: null, kind: 'tv', season: 1, episode: 3 });
  assert.equal(parseRelease('Show Name Season 3 Complete 1080p').season, 3);
  assert.equal(parseRelease('Show.Name.2019.S01.1080p.WEB').year, 2019);
});

test('titles without tags are kept whole', () => {
  assert.deepEqual(parseRelease('Sintel - 2010 - Multisubs mkv'), { title: 'Sintel', year: 2010, kind: 'movie', season: null, episode: null });
  assert.equal(parseRelease('Just A Title').title, 'Just A Title');
  assert.equal(parseRelease('1080p'), null);
  assert.equal(parseRelease(''), null);
});

test('hyphens inside a title are kept', () => {
  assert.equal(parseRelease('The.Amazing.Spider-Man.2012.1080p.BluRay.x264').title, 'The Amazing Spider-Man');
  assert.equal(parseRelease('Spider-Man Brand New Day (2026) [1080p] [WEBRip]').title, 'Spider-Man Brand New Day');
});

test('a series with a year in its name still reads as a series', () => {
  assert.deepEqual(parseRelease('Scrubs 2026 S02E05 1080p HDTV x264-SYNCOPY'), { title: 'Scrubs', year: 2026, kind: 'tv', season: 2, episode: 5 });
  assert.deepEqual(parseRelease('Lanterns.2026.S01E08.1080p.WEB.h264-ETHEL'), { title: 'Lanterns', year: 2026, kind: 'tv', season: 1, episode: 8 });
  assert.equal(parseRelease('Show.Name.2019.S01.1080p.WEB').kind, 'tv');
});

test('title keys ignore punctuation, case, accents and spacing', () => {
  assert.equal(titleKey('Spider-Man: Brand New Day'), titleKey('Spider Man Brand New Day'));
  assert.equal(titleKey('Amélie'), titleKey('Amelie'));
  assert.equal(titleKey('Fast & Furious'), titleKey('Fast and Furious'));
  assert.notEqual(titleKey('Hope'), titleKey('Hopes'));
});

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Title pages: episodes inside packs, what was watched of a title, which copy plays an
// episode, the page's main buttons, and its place in the history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeOf, episodeFile, episodeTag } from '../src/shared/episodes.js';
import { progressFor, episodeChoice, identityOf } from '../src/main/titles.js';
import { cardMeta } from '../src/main/browse.js';
import { titleActions, nextEpisode } from '../src/renderer/lib/title-actions.js';
import { same } from '../src/renderer/lib/nav.js';
import { continueWatching } from '../src/renderer/views/browse.js';

const video = (index, path, length = 1e9) => ({ index, path, length, kind: 'video' });

test('an episode is found in a pack however its files are named', () => {
  assert.deepEqual(episodeOf('Show.S01E03.1080p.mkv'), { season: 1, episode: 3 });
  assert.deepEqual(episodeOf('Show 1x03 Title.mkv'), { season: 1, episode: 3 });
  assert.deepEqual(episodeOf('Show/Season 2/03 - The Name.mkv'), { season: 2, episode: 3 });
  assert.deepEqual(episodeOf('Show/S02/Episode 4.mkv'), { season: 2, episode: 4 });
  assert.deepEqual(episodeOf('Show.S01E01E02.mkv'), { season: 1, episode: 1 }, 'a double episode is its first');
  assert.equal(episodeOf('Show.2024.1080p.mkv'), null);
  const files = [video(0, 'Pack/Show.S01E01.mkv'), video(1, 'Pack/Show.S01E02.mkv'), video(2, 'Pack/Sample/Show.S01E02.sample.mkv', 1e7), { index: 3, path: 'Pack/Show.S01E02.srt', length: 1e4, kind: 'subtitle' }];
  assert.equal(episodeFile(files, 1, 2).index, 1, 'not the sample, not the subtitles');
  assert.equal(episodeFile(files, 1, 9), null);
  assert.equal(episodeTag(1, 3), 'S01E03');
});

test('what was watched of a title: a film, or each episode of a series', () => {
  const items = [
    { infoHash: 'a', fileIndex: 4, source: 'magnet:a', title: 'Show.S02E06.1080p.mkv', torrentName: 'Show.S02.1080p.WEB', positionSecs: 600, durationSecs: 3000, completed: false },
    { infoHash: 'b', fileIndex: 0, source: 'magnet:b', title: 'Show.S02E05.1080p.mkv', torrentName: 'Show.S02E05.1080p.WEB', positionSecs: 3000, durationSecs: 3000, completed: true },
    { infoHash: 'c', fileIndex: 0, source: 'magnet:c', title: 'Film.2024.1080p.mkv', torrentName: 'Film.2024.1080p.WEB', positionSecs: 5, durationSecs: 6000, completed: false },
    { infoHash: 'd', fileIndex: 0, source: 'magnet:d', title: 'Film.1990.1080p.mkv', torrentName: 'Film.1990.1080p', positionSecs: 900, durationSecs: 6000, completed: false },
  ];
  const show = progressFor(items, identityOf({ kind: 'tv', title: 'Show', year: null }));
  assert.equal(show.last.episode, 6, 'the most recent first');
  assert.equal(show.episodes.S2E6.resumeSecs, 600);
  assert.equal(show.episodes.S2E5.completed, true);
  const film = progressFor(items, identityOf({ kind: 'movie', title: 'Film', year: 2024 }));
  assert.equal(film.resume.infoHash, 'c', 'the 1990 film of the same name is another film');
  assert.equal(film.resume.resumeSecs, null, 'five seconds in is not worth resuming');
});

test('an episode plays from its own copy, else a season pack, else a complete pack', () => {
  const t = (key, season, episode, seeders = 10) => ({ key, link: `magnet:${key}`, title: key, season, episode, seeders, peers: 1, sizeBytes: 2e9, quality: { kind: 'video', playable: 'yes' } });
  assert.equal(episodeChoice([t('pack', 1, null, 999), t('e3', 1, 3)], 1, 3).torrent.key, 'e3');
  const pack = episodeChoice([t('pack', 1, null), t('s2', 2, null)], 1, 3);
  assert.deepEqual([pack.torrent.key, pack.via, pack.pick], ['pack', 'pack', { season: 1, episode: 3 }]);
  assert.equal(episodeChoice([t('all', null, null)], 1, 3).via, 'completePack');
  assert.equal(episodeChoice([t('s2', 2, null)], 1, 3), null);
});

test("a title page's main buttons follow what was watched", () => {
  const best = { link: 'magnet:x' };
  assert.deepEqual(titleActions({ kind: 'movie', progress: null, best, episodes: [] }).primary, { label: 'Play', play: { kind: 'torrent', torrent: best } });
  const watching = { resume: { resumeSecs: 3725, completed: false }, episodes: {}, last: null };
  const film = titleActions({ kind: 'movie', progress: watching, best, episodes: [] });
  assert.equal(film.primary.label, 'Resume from 1:02:05');
  assert.equal(film.secondary.label, 'Play from start');
  assert.equal(film.secondary.play.fromStart, true);
  const episodes = [{ season: 1, number: 1 }, { season: 1, number: 2 }, { season: 2, number: 1 }];
  assert.equal(titleActions({ kind: 'tv', progress: null, best, episodes }).primary.label, 'Play S1 E1');
  const finished = { last: { season: 1, episode: 2, completed: true, resumeSecs: null }, episodes: {} };
  assert.equal(titleActions({ kind: 'tv', progress: finished, best, episodes }).primary.label, 'Play S2 E1', 'on to the next season');
  const midway = { last: { season: 1, episode: 2, completed: false, resumeSecs: 90 }, episodes: {} };
  const tv = titleActions({ kind: 'tv', progress: midway, best, episodes });
  assert.deepEqual([tv.primary.label, tv.secondary.label], ['Resume S1 E2 · 1:30', 'S1 E2 from the start']);
  assert.equal(nextEpisode(episodes, 2, 1), null, 'nothing after the last');
});

test('each title is its own place in the history', () => {
  assert.equal(same({ view: 'title', key: 'movie:dune:2021' }, { view: 'title', key: 'movie:dune:2021' }), true);
  assert.equal(same({ view: 'title', key: 'movie:dune:2021' }, { view: 'title', key: 'movie:dune:1984' }), false);
  assert.equal(same({ view: 'browse' }, { view: 'browse' }), true);
});

test('Continue watching: one card per title, the series at its last episode, only what is worth continuing', () => {
  const list = continueWatching([
    { title: 'Show.S02E06.1080p.mkv', torrentName: 'Show.S02.1080p.WEB', positionSecs: 600, durationSecs: 3000, completed: false },
    { title: 'Show.S02E05.1080p.mkv', torrentName: 'Show.S02.1080p.WEB', positionSecs: 900, durationSecs: 3000, completed: false },
    { title: 'Film.2024.1080p.mkv', torrentName: 'Film.2024.1080p.WEB', positionSecs: 5, durationSecs: 6000, completed: false },
    { title: 'Done.2020.mkv', torrentName: 'Done.2020.1080p', positionSecs: 6000, durationSecs: 6000, completed: true },
  ]);
  assert.deepEqual(list.map((t) => [t.key, t.note]), [['tv:show', 'S2 E6 · 40:00 left']]);
});

test('Browse cards carry a short version of the information', () => {
  const card = cardMeta({ v: 1, kind: 'tv', title: 'Show', overview: 'x'.repeat(2000), poster: 'p', genres: ['a', 'b', 'c', 'd', 'e'], cast: [{ name: 'n' }], seasons: [{ number: 1 }] });
  assert.equal(card.overview.length, 400);
  assert.equal(card.genres.length, 4);
  assert.equal('cast' in card || 'seasons' in card, false, 'a title page asks for the rest');
  assert.equal(cardMeta(null), null);
});

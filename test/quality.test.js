// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuality, rank, reason, watchScore, tokens, pickable } from '../src/shared/quality.js';

test('parses resolution, source, codec, container, audio', () => {
  const q = parseQuality('Sintel.2010.1080p.WEB.H264-CLASSiCALHD', 'Movies', 583_689_809);
  assert.equal(q.resolution, '1080p');
  assert.equal(q.source, 'WEB-DL');
  assert.equal(q.codec, 'x264');
  assert.equal(q.kind, 'video');
  assert.equal(q.label, '1080p WEB-DL');
  const mkv = parseQuality('Show.S01E01.2160p.HDR.BluRay.x265.DDP5.1.Atmos.mkv', null, 9e9);
  assert.equal(mkv.resolution, '2160p');
  assert.equal(mkv.hdr, true);
  assert.equal(mkv.container, 'MKV');
  assert.equal(mkv.audio, 'Dolby Digital Plus');
  assert.equal(mkv.audioPlays, false);
  assert.equal(mkv.playable, 'unlikely');
});

test('flags camera copies, fake 4K, and files that need a full player', () => {
  assert.equal(parseQuality('Movie 2024 1080p HDTS x264', null, null).camera, true);
  assert.equal(parseQuality('Movie 2024 2160p WEB x265', null, 100 * 1024 * 1024).suspectSize, true);
  assert.equal(parseQuality('Old.Film.1999.DVDRip.XviD.avi', null, null).playable, 'needsFullPlayer');
  assert.equal(parseQuality('Album - Artist (2020) [FLAC]', null, null).kind, 'audio');
  assert.equal(parseQuality('Some Book 2nd Edition epub', null, null).kind, 'notVideo');
});

test('plays-in-browser detection prefers MP4 and WebM', () => {
  assert.equal(parseQuality('Film 2020 1080p WEB-DL AAC x264 mp4', null, null).playable, 'plays');
  assert.equal(parseQuality('Film 2020 1080p YTS', null, null).playable, 'plays');
});

test('ranking puts fully matching, seeded, playable results first and marks one best pick', () => {
  const make = (title, seeders, size = 2e9) => {
    const quality = parseQuality(title, 'Movies', size);
    return { title, seeders, peers: seeders, sizeBytes: size, quality, reason: reason(seeders, quality), watchScore: watchScore(seeders, seeders, quality), bestPick: false };
  };
  const results = [make('Other Film 1080p WEB x264', 500), make('Sintel 2010 1080p WEB x264 mp4', 30), make('Sintel 2010 HDCAM', 900), make('Sintel 2010 720p', 0)];
  const ranked = rank(results, 'sintel');
  assert.equal(ranked[0].bestPick, true);
  assert.equal(ranked[0].title, 'Sintel 2010 1080p WEB x264 mp4');
  assert.equal(ranked.filter((r) => r.bestPick).length, 1);
  assert.equal(ranked.at(-1).title, 'Other Film 1080p WEB x264');
  assert.equal(pickable(results[2]), false);
  assert.match(ranked[0].reason, /1080p WEB-DL · 30 seeders · plays in built-in player/);
});

test('tokens keep decimal numbers together', () => {
  assert.deepEqual(tokens('MIT 6.006 & more'), ['mit', '6.006', 'more']);
});

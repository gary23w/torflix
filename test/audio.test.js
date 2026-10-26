// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioTracks, chooseTrack, decodes, codecName } from '../src/main/media-tools.js';
import { parseQuality, reason, watchScore } from '../src/shared/quality.js';

const probe = {
  streams: [
    { index: 1, codec_name: 'eac3', channels: 6, tags: { language: 'jpn' }, disposition: { default: 1 } },
    { index: 2, codec_name: 'eac3', channels: 6, tags: { language: 'eng', title: 'English 5.1' }, disposition: { default: 0 } },
    { index: 3, codec_name: 'aac', channels: 2, tags: {}, disposition: { default: 0 } },
  ],
};

test('ffprobe audio streams are normalized with labels and decodability', () => {
  const tracks = audioTracks(probe);
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks.map((t) => [t.n, t.codec, t.language, t.decodes]), [
    [0, 'eac3', 'ja', false],
    [1, 'eac3', 'en', false],
    [2, 'aac', null, true],
  ]);
  assert.equal(tracks[1].label, 'Dolby Digital Plus · 5.1 · English');
  assert.equal(codecName('dts'), 'DTS');
  assert.equal(decodes('opus'), true);
  assert.equal(decodes('ac3'), false);
  assert.equal(decodes('pcm_s16le'), true);
});

test('the track in the viewer’s language plays, else the default one', () => {
  const tracks = audioTracks(probe);
  assert.equal(chooseTrack(tracks, ['en-US', 'en']), 1);
  assert.equal(chooseTrack(tracks, ['fr-FR']), 0, 'falls back to the default track');
  assert.equal(chooseTrack([], ['en']), null);
});

test('with FFmpeg, Dolby audio no longer counts against a result', () => {
  const title = 'Film.2026.1080p.WEB-DL.DDP5.1.H.264-GROUP.mkv';
  const silent = parseQuality(title, 'Movies', 4e9);
  const converted = parseQuality(title, 'Movies', 4e9, null, { audioConverts: true });
  assert.equal(silent.audioPlays, false);
  assert.equal(converted.audioPlays, true);
  assert.equal(silent.playable, 'unlikely');
  assert.equal(converted.playable, 'likely');
  assert.match(reason(50, silent), /no sound in built-in player/);
  assert.doesNotMatch(reason(50, converted), /no sound/);
  assert.ok(watchScore(50, 60, converted) > watchScore(50, 60, silent));
});

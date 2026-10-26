// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, describeSubtitle } from '../src/shared/subtitles.js';
import { playTarget, lectureOrder, fileKind } from '../src/shared/files.js';

test('parses SRT with tags stripped', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n<i>Hello</i> there\n\n2\n00:00:04,000 --> 00:00:05,000\nBye\n';
  const out = parseSubtitles(srt, 'x.srt');
  assert.equal(out.format, 'srt');
  assert.deepEqual(out.cues, [
    { startMs: 1000, endMs: 3500, text: 'Hello there' },
    { startMs: 4000, endMs: 5000, text: 'Bye' },
  ]);
});

test('parses WebVTT and ASS', () => {
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n\n01:00:03.000 --> 01:00:04.000\nTwo';
  assert.equal(parseSubtitles(vtt).cues.length, 2);
  assert.equal(parseSubtitles(vtt).cues[1].startMs, 3_603_000);
  const ass = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:02.00,Default,,0,0,0,,{\\an8}Hi,\\Nthere';
  const out = parseSubtitles(ass, 'x.ass');
  assert.equal(out.format, 'ass');
  assert.deepEqual(out.cues, [{ startMs: 1500, endMs: 2000, text: 'Hi,\nthere' }]);
});

test('describes subtitle files by language and match', () => {
  const d = describeSubtitle({ index: 3, path: 'Film.2010.1080p/Film.2010.1080p.en.forced.srt', length: 1000 }, 'Film.2010.1080p/Film.2010.1080p.mkv');
  assert.equal(d.label, 'English (forced)');
  assert.equal(d.language, 'en');
  assert.equal(d.matched, true);
  const other = describeSubtitle({ index: 4, path: 'Subs/Spanish.srt', length: 10 }, 'Film.mkv', 1);
  assert.equal(other.label, 'Spanish');
  assert.equal(other.matched, true);
});

test('picks the main video and orders lectures naturally', () => {
  const files = [
    { index: 0, path: 'Course/Lecture 10.mp4', length: 500, kind: 'video' },
    { index: 1, path: 'Course/Lecture 2.mp4', length: 400, kind: 'video' },
    { index: 2, path: 'Course/Sample.mp4', length: 900, kind: 'video' },
    { index: 3, path: 'Course/notes.pdf', length: 9, kind: 'document' },
  ];
  assert.deepEqual(lectureOrder(files).map((f) => f.index), [1, 0, 2]);
  assert.equal(playTarget(files).index, 0);
  assert.equal(fileKind('a/b.MKV'), 'video');
  assert.equal(fileKind('a/b.m4b'), 'audio');
});

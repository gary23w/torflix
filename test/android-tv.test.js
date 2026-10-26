// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pickNext, isTv } from '../src/renderer/lib/tv.js';
import { cuesToSrt } from '../src/renderer/lib/subtitles.js';
import { toWire } from '../src/android/bridge.js';

const box = (left, top, w = 100, hgt = 60) => ({ left, top, right: left + w, bottom: top + hgt });
const cand = (name, rect) => ({ rect, item: name });

test('the remote moves to the next control straight ahead', () => {
  // A row of posters, a second row below, the rail on the left.
  const row1 = [cand('a1', box(100, 100)), cand('a2', box(220, 100)), cand('a3', box(340, 100))];
  const row2 = [cand('b1', box(100, 200)), cand('b2', box(220, 200)), cand('b3', box(340, 200))];
  const rail = [cand('r1', box(0, 100, 60, 40)), cand('r2', box(0, 160, 60, 40)), cand('r3', box(0, 220, 60, 40))];
  const all = [...row1, ...row2, ...rail];
  const from = box(220, 100);
  assert.equal(pickNext(from, all, 'right'), 'a3');
  assert.equal(pickNext(from, all, 'left'), 'a1');
  assert.equal(pickNext(from, all, 'down'), 'b2');
  assert.equal(pickNext(from, all, 'up'), null);
  // From the first poster, left goes to the rail button beside it, not the one nearest a corner.
  assert.equal(pickNext(box(100, 100), all, 'left'), 'r1');
  // Down the rail stays in the rail.
  assert.equal(pickNext(box(0, 100, 60, 40), all, 'down'), 'r2');
});

test('a control in line wins over a nearer one off to the side', () => {
  const from = box(100, 100);
  const inLine = cand('far-below', box(100, 400));
  const aside = cand('near-diagonal', box(260, 180));
  assert.equal(pickNext(from, [inLine, aside], 'down'), 'far-below');
});

test('only Android TV turns on remote control', () => {
  assert.equal(isTv({ platform: 'android-tv' }), true);
  assert.equal(isTv({}), false);
  assert.equal(isTv(undefined), false);
});

test('cues become an SRT file the TV player reads, with markup escaped', () => {
  const srt = cuesToSrt([
    { startMs: 1000, endMs: 2500, text: 'Hello <there> & you' },
    { startMs: 3_723_004, endMs: 3_725_000, text: 'Two\nlines' },
  ]);
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:02,500\nHello &lt;there&gt; &amp; you\n\n2\n01:02:03,004 --> 01:02:05,000\nTwo\nlines\n');
});

/** Runs the page's bridge shim in a sandbox with a stand-in backend. */
function loadShim({ answer, native = null }) {
  const calls = [];
  const sources = [];
  const sandbox = {
    Uint8Array,
    btoa,
    atob,
    JSON,
    console,
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      const a = answer(url);
      return { ok: a.status === undefined, status: a.status ?? 200, json: async () => a };
    },
    EventSource: class {
      constructor(url) {
        this.url = url;
        sources.push(this);
      }
    },
  };
  if (native) sandbox.tpNative = native;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../src/android/tp-shim.js', import.meta.url), 'utf8'), sandbox);
  return { tp: sandbox.tp, calls, sources, sandbox };
}

test('the shim sends commands to the bridge in its wire format, bytes included', async () => {
  const { tp, calls } = loadShim({ answer: () => ({ ok: true, value: { cues: [], raw: { $bytes: 'AQI=' } } }) });
  const value = await tp.parseSubtitles(new Uint8Array([1, 2]), 'x.srt');
  assert.equal(calls[0].url, '/rpc/parseSubtitles');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, toWire([new Uint8Array([1, 2]), 'x.srt']));
  assert.ok(value.raw instanceof Uint8Array);
  assert.deepEqual([...value.raw], [1, 2]);
  assert.equal(tp.platform, 'android-tv');
  assert.ok(Object.isFrozen(tp));
});

test('a failed command throws with the kind and field errors the page relies on', async () => {
  const fieldErrors = [{ field: 'playback.defaultSpeed', message: 'Choose a speed between 0.5× and 3×.' }];
  const { tp } = loadShim({ answer: (url) => (url.endsWith('updateSettings') ? { ok: false, error: { kind: 'invalidSettings', message: 'Bad', fieldErrors } } : { status: 403 }) });
  await assert.rejects(tp.updateSettings({}), (err) => err.kind === 'invalidSettings' && err.fieldErrors[0].field === 'playback.defaultSpeed');
  await assert.rejects(tp.listTorrents(), (err) => err.kind === 'bridge');
});

test('events from the backend and from the app reach subscribers, bytes revived', () => {
  const { tp, sources, sandbox } = loadShim({ answer: () => ({ ok: true, value: null }) });
  assert.equal(sources[0].url, '/events');
  const got = [];
  const off = tp.on('open-torrent', (p) => got.push(p));
  tp.on('tv-back', (p) => got.push(['back', p]));
  tp.on('native-player', (p) => got.push(p));
  sources[0].onmessage({ data: JSON.stringify({ name: 'open-torrent', payload: { kind: 'file', value: { $bytes: 'AQI=' } } }) });
  assert.ok(got[0].value instanceof Uint8Array);
  sandbox.__tpNativeEmit('tv-back', 'null');
  sandbox.__tpNativeEmit('native-player', JSON.stringify({ type: 'ended', streamId: 3 }));
  assert.deepEqual(got.slice(1), [['back', null], { type: 'ended', streamId: 3 }]);
  off();
  sources[0].onmessage({ data: JSON.stringify({ name: 'open-torrent', payload: { kind: 'magnet', value: 'magnet:?' } }) });
  assert.equal(got.length, 3);
});

test('links open through the app on the TV, and only http(s) ones', async () => {
  const opened = [];
  const { tp, calls } = loadShim({ answer: () => ({ ok: true, value: true }), native: { openLink: (u) => opened.push(u) } });
  assert.equal(await tp.openLink('https://example.org/x'), true);
  await assert.rejects(tp.openLink('file:///etc/passwd'), (err) => err.kind === 'invalid');
  assert.deepEqual(opened, ['https://example.org/x']);
  assert.equal(calls.length, 0);
});

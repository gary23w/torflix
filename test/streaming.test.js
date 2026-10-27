// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Selections } from 'webtorrent/lib/selections.js';
import { addFocus, removeFocus, MovingFocus, FOCUS_PRIORITY } from '../src/main/pieces.js';
import { ResumeStore } from '../src/main/resume.js';
import { Streams } from '../src/main/streams.js';

/** A torrent with WebTorrent 3's real selection list and just enough else for the helpers. */
function fakeTorrent({ pieces = 100, pieceLength = 1024 * 1024, have = [] } = {}) {
  const bits = new Set(have);
  const t = {
    ready: true,
    destroyed: false,
    pieceLength,
    pieces: new Array(pieces).fill(null),
    bitfield: { get: (i) => bits.has(i), buffer: new Uint8Array(Math.ceil(pieces / 8)) },
    _selections: new Selections(),
    critical: [],
    updates: 0,
  };
  t.critical = (a, b) => t.criticalCalls.push([a, b]);
  t.criticalCalls = [];
  t._updateSelections = () => (t.updates += 1);
  // What `torrent.select()` does: merged into other plain selections, then sorted by priority.
  t.select = (from, to, priority) => {
    t._selections.insert({ from, to, offset: 0, priority, isStreamSelection: false });
    t._selections.sort((a, b) => b.priority - a.priority);
  };
  t.have = (i) => bits.add(i);
  return t;
}

const items = (t) => t._selections._items.map((s) => `${s.from}-${s.to}@${s.priority}${s.isStreamSelection ? 's' : ''}`);

test('a focus goes ahead of the file and the player reads, without merging into them', () => {
  const t = fakeTorrent();
  t.select(0, 99, 0); // the rest of the file being watched
  t._selections.insert({ from: 40, to: 99, offset: 0, priority: 1, isStreamSelection: true }); // a player read
  const f = addFocus(t, 40, 42);
  assert.ok(f);
  assert.deepEqual(items(t), [`40-42@${FOCUS_PRIORITY}s`, '40-99@1s', '0-99@0']);
  assert.deepEqual(t.criticalCalls, [[40, 42]]);
  // torrent.select() of the same pieces would have lifted the whole file to its priority:
  const merged = fakeTorrent();
  merged.select(0, 99, 0);
  merged.select(40, 42, FOCUS_PRIORITY);
  assert.deepEqual(items(merged), [`0-99@${FOCUS_PRIORITY}`]);
});

test('removing a focus removes exactly that one, not a read over the same pieces', () => {
  const t = fakeTorrent();
  const read = { from: 5, to: 6, offset: 0, priority: FOCUS_PRIORITY, isStreamSelection: true };
  t._selections.insert(read);
  const f = addFocus(t, 5, 6);
  removeFocus(t, f);
  assert.equal(t._selections._items.length, 1);
  assert.equal(t._selections._items[0], read);
  removeFocus(t, f); // twice is harmless
  assert.equal(t._selections._items.length, 1);
});

test('no focus when every piece of the run is already there', () => {
  const t = fakeTorrent({ have: [3, 4, 5] });
  assert.equal(addFocus(t, 3, 5), null);
  assert.ok(addFocus(t, 3, 6));
});

test('a moving focus follows the reader and leaves nothing behind', () => {
  const t = fakeTorrent({ pieceLength: 8 * 1024 * 1024 });
  const file = { _torrent: t, offset: 0, length: 100 * 8 * 1024 * 1024 };
  const m = new MovingFocus(file);
  m.moveTo(0);
  assert.deepEqual(items(t), ['0-2@3s']); // 24 MiB of 8 MiB pieces
  m.moveTo(8 * 1024 * 1024 * 10 + 5);
  assert.deepEqual(items(t), ['10-12@3s']);
  m.clear();
  assert.deepEqual(items(t), []);
});

test('resume data: metadata once, the piece map, forgetting, pruning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-resume-'));
  try {
    const store = new ResumeStore(dir);
    const hash = 'a'.repeat(40);
    const t = { infoHash: hash, torrentFile: Buffer.from('d4:infod4:name1:xee'), pieces: new Array(12).fill(null), bitfield: { buffer: new Uint8Array([0b10100000, 0b00010000, 0, 0]) } };
    assert.deepEqual(store.load(hash), { torrentFile: null, bitfield: null });
    await store.saveMetadata(t);
    await store.saveBitfield(t);
    const loaded = store.load(hash);
    assert.equal(loaded.torrentFile.toString(), 'd4:infod4:name1:xee');
    assert.deepEqual([...loaded.bitfield], [0b10100000, 0b00010000]); // exactly ceil(12 / 8) bytes
    assert.deepEqual(store.load('not a hash'), { torrentFile: null, bitfield: null });
    await store.forget(hash);
    assert.deepEqual(store.load(hash), { torrentFile: null, bitfield: null });
    for (let i = 0; i < 5; i++) await store.saveMetadata({ ...t, infoHash: String(i).repeat(40) });
    await store.prune(3);
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.torrent')).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Streams over a fake engine whose adds resolve when the test says so. */
function fakeStreams({ path = 'Film.mkv' } = {}) {
  const pending = new Map();
  const entries = new Map();
  const entryFor = (hash) => {
    if (!entries.has(hash)) {
      const torrent = fakeTorrent({ pieces: 1000 });
      const file = { offset: 0, length: 1e9, path, _torrent: torrent, select() {}, deselect() {} };
      entries.set(hash, { id: entries.size + 1, infoHash: hash, name: hash, torrent, file, bgSelected: new Set(), lastUsedAt: 0 });
    }
    return entries.get(hash);
  };
  const engine = {
    debug: false,
    add: (_source, { infoHash }) => new Promise((resolve) => pending.set(infoHash, () => resolve(entryFor(infoHash)))),
    files: () => [{ index: 0, path, length: 1e9, kind: 'video' }],
    file: (entry) => entry.file,
    magnetOf: (entry) => `magnet:?xt=urn:btih:${entry.infoHash}`,
  };
  const server = { register() {}, unregister() {}, url: (id) => `http://x/${id}`, status: () => null };
  const library = { opened() {}, resumePosition: () => null, get: () => null };
  const settings = { settings: { playback: { resumePosition: true } } };
  return { streams: new Streams({ engine, server, library, settings }), resolve: (hash) => pending.get(hash)() };
}

test('a Play overtaken by a newer one gives up instead of replacing it', async () => {
  const { streams, resolve } = fakeStreams();
  const slow = streams.start({ source: 'magnet:?a', infoHash: 'a' });
  const fast = streams.start({ source: 'magnet:?b', infoHash: 'b' });
  resolve('b');
  const b = await fast;
  resolve('a');
  await assert.rejects(slow, (err) => err.kind === 'superseded');
  assert.equal(streams.active().infoHash, 'b');
  assert.equal(streams.active().id, b.streamId);
});

test('Play on what is already playing keeps the same stream', async () => {
  const { streams, resolve } = fakeStreams();
  const first = streams.start({ source: 'magnet:?a', infoHash: 'a' });
  resolve('a');
  const a = await first;
  const again = streams.start({ source: 'magnet:?a', infoHash: 'a' });
  resolve('a');
  assert.equal((await again).streamId, a.streamId);
  assert.equal(streams.streams.size, 1);
});

test('Play fetches a Matroska file’s end with its start, an MP4’s only with what is left over', async () => {
  const opened = async (path) => {
    const { streams, resolve } = fakeStreams({ path });
    const start = streams.start({ source: 'magnet:?a', infoHash: 'a' });
    resolve('a');
    await start;
    return streams.active().entry.torrent;
  };
  const last = 953; // the piece of byte 1e9 - 1, at 1 MiB a piece
  const mkv = await opened('Film.mkv');
  assert.deepEqual(items(mkv), ['0-3@3s', `${last - 2}-${last}@3s`]);
  assert.deepEqual(mkv.criticalCalls, [[0, 3], [last - 2, last]]);
  const mp4 = await opened('Film.mp4');
  assert.deepEqual(items(mp4), ['0-3@3s', `${last - 2}-${last}@1s`]);
  assert.deepEqual(mp4.criticalCalls, [[0, 3]]);
});

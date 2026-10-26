// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, findItem, groups, makeItem, nextItem, optimize, entryState, moveItem } from '../src/renderer/lib/queue.js';
import { applyFilters, holdOrder, DEFAULT_FILTERS } from '../src/renderer/views/search.js';

const empty = () => ({ version: 2, items: [], current: null, order: 'inOrder' });
const item = (over) => makeItem({ source: 'magnet:?xt=urn:btih:a', infoHash: 'a'.repeat(40), fileIndex: 0, title: 'Lecture 1', torrentName: 'Course', ...over });

test('files of a torrent join their group, other torrents append', () => {
  let { queue } = enqueue(empty(), [item({ title: 'Lecture 1', fileIndex: 0 })]);
  ({ queue } = enqueue(queue, [makeItem({ source: 'magnet:?xt=urn:btih:b', infoHash: 'b'.repeat(40), fileIndex: null, title: 'Film' })]));
  ({ queue } = enqueue(queue, [item({ title: 'Lecture 2', fileIndex: 1 })]));
  assert.deepEqual(queue.items.map((i) => i.title), ['Lecture 1', 'Lecture 2', 'Film']);
  assert.equal(groups(queue).length, 2);
  const again = enqueue(queue, [item({ title: 'Lecture 2', fileIndex: 1 })]);
  assert.equal(again.added.length, 0, 'the same file is not queued twice');
});

test('a request for the main video matches the torrent already queued', () => {
  const { queue } = enqueue(empty(), [item({ fileIndex: 0 })]);
  const found = findItem(queue, { infoHash: 'a'.repeat(40), source: 'magnet:?xt=urn:btih:a&dn=other', fileIndex: null });
  assert.ok(found, 'null file index matches the first queued file of that torrent');
  assert.equal(findItem(queue, { infoHash: 'a'.repeat(40), source: '', fileIndex: 3 }), null);
  assert.equal(entryState({ ...queue, current: queue.items[0].id }, { infoHash: 'a'.repeat(40), source: '', fileIndex: null }), 'playing');
});

test('next item skips skipped ones and moving stays inside a group', () => {
  let { queue } = enqueue(empty(), [item({ title: 'L1', fileIndex: 0 }), item({ title: 'L2', fileIndex: 1 }), item({ title: 'L3', fileIndex: 2 })]);
  queue = { ...queue, current: queue.items[0].id, items: queue.items.map((i, n) => (n === 1 ? { ...i, skipped: true } : i)) };
  assert.equal(nextItem(queue).title, 'L3');
  const moved = moveItem(queue, queue.items[2].id, -1);
  assert.deepEqual(moved.items.map((i) => i.title), ['L1', 'L3', 'L2']);
});

test('optimize moves ready torrents ahead but never the one playing', () => {
  let { queue } = enqueue(empty(), [
    makeItem({ source: 'magnet:?xt=urn:btih:x', infoHash: 'x'.repeat(40), fileIndex: null, title: 'Playing' }),
    makeItem({ source: 'magnet:?xt=urn:btih:y', infoHash: 'y'.repeat(40), fileIndex: null, title: 'Waiting' }),
    makeItem({ source: 'magnet:?xt=urn:btih:z', infoHash: 'z'.repeat(40), fileIndex: null, title: 'Ready' }),
  ]);
  queue = { ...queue, current: queue.items[0].id };
  const readiness = [{ id: queue.items[2].id, state: 'ready', downloaded: 1, length: 1 }];
  const out = optimize(queue, readiness, true);
  assert.deepEqual(out.items.map((i) => i.title), ['Playing', 'Ready', 'Waiting']);
  assert.equal(optimize(out, readiness, true), null, 'nothing moves the second time');
});

test('held order keeps shown rows in place and appends new ones', () => {
  const rows = [{ key: 'c' }, { key: 'a' }, { key: 'd' }, { key: 'b' }];
  assert.deepEqual(holdOrder(['a', 'b', 'gone'], rows).map((r) => r.key), ['a', 'b', 'c', 'd']);
  assert.deepEqual(holdOrder([], rows).map((r) => r.key), ['c', 'a', 'd', 'b']);
});

test('filters narrow by resolution, seeders, indexer and kind', () => {
  const q = (over) => ({ resolution: null, playable: 'unknown', kind: 'video', ...over });
  const results = [
    { key: '1', title: 'A 1080p', seeders: 50, indexers: ['YTS'], quality: q({ resolution: '1080p', playable: 'plays' }), sizeBytes: 1, published: null },
    { key: '2', title: 'B 720p', seeders: 3, indexers: ['Knaben'], quality: q({ resolution: '720p' }), sizeBytes: 2, published: null },
    { key: '3', title: 'C album', seeders: 9, indexers: ['Knaben'], quality: q({ kind: 'audio' }), sizeBytes: 3, published: null },
  ];
  assert.deepEqual(applyFilters(results, { ...DEFAULT_FILTERS, resolution: '1080p' }).map((r) => r.key), ['1']);
  assert.deepEqual(applyFilters(results, { ...DEFAULT_FILTERS, minSeeders: 10 }).map((r) => r.key), ['1']);
  assert.deepEqual(applyFilters(results, { ...DEFAULT_FILTERS, indexer: 'Knaben' }).map((r) => r.key), ['2', '3']);
  assert.deepEqual(applyFilters(results, { ...DEFAULT_FILTERS, kind: 'audio' }).map((r) => r.key), ['3']);
  assert.deepEqual(applyFilters(results, { ...DEFAULT_FILTERS, sort: 'seeders' }).map((r) => r.key), ['1', '3', '2']);
});

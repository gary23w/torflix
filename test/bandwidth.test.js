// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/main/settings.js';
import { Downloads } from '../src/main/downloads.js';

test('only the video being watched downloads by default: background work is opt-in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-settings-'));
  try {
    const store = new SettingsStore(dir, dir);
    const s = store.settings;
    assert.equal(s.bandwidth.backgroundDownloads, false);
    assert.equal(s.bandwidth.seedAfterWatching, false);
    assert.equal(s.search.preloadTopResult, false);
    assert.equal(s.search.prefetchResults, false);
    assert.throws(() => store.update({ bandwidth: { backgroundDownloads: 'yes' } }));
    store.update({ bandwidth: { backgroundDownloads: true }, search: { prefetchResults: true } });
    assert.equal(store.settings.bandwidth.backgroundDownloads, true);
    assert.equal(store.settings.search.prefetchResults, true);
    await store.flush?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A downloader over fake torrents; `tick()` runs one round of its once-a-second work. */
function rig({ backgroundDownloads = false, seedAfterWatching = false, entries = [], queue = [], stream = null } = {}) {
  const added = [];
  const engine = {
    entries: new Map(entries.map((e) => [e.id, e])),
    byInfoHash: (h) => entries.find((e) => e.infoHash === h) ?? null,
    bySource: () => null,
    files: () => [{ index: 0, path: 'Film.mkv', length: 100, kind: 'video' }],
    file: (e) => e.file,
    totals: () => ({ downloadBps: 0, uploadBps: 0 }),
    add: (source) => (added.push(source), new Promise(() => {})),
  };
  const settings = { settings: { bandwidth: { backgroundDownloads, seedAfterWatching, seedRatioTarget: 2, seedTimeLimitMinutes: 0, maxDownloads: 0 } } };
  const library = { queue: { items: queue, current: null, order: 'inOrder' } };
  const streams = { active: () => stream, server: { status: () => null } };
  const d = new Downloads({ engine, library, streams, settings });
  return {
    d,
    added,
    tick: async () => {
      d.start();
      await new Promise((r) => setTimeout(r, 1150));
      d.stop();
    },
  };
}

const torrent = () => ({ destroyed: false, paused: false, wires: [{ destroyed: false, destroy() { this.destroyed = true; } }], files: [{ length: 100, downloaded: 10 }], pause() { this.paused = true; }, resume() { this.paused = false; }, ratio: 0, uploadSpeed: 0 });
const entry = (id, hash) => {
  const t = torrent();
  return { id, infoHash: hash, source: `magnet:?xt=urn:btih:${hash}`, ready: true, claimed: true, origin: 'user', torrent: t, file: { length: 100, downloaded: 10, select() {}, deselect() {} }, bgSelected: new Set(), completedAt: null, pausedForSeeding: false };
};

test('with background downloads off, a queued video waits to be played and nothing is added', async () => {
  const { d, added, tick } = rig({ queue: [{ id: 'q1', source: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), infoHash: 'a'.repeat(40), fileIndex: null, title: 'Film', paused: false, skipped: false }] });
  await tick();
  assert.deepEqual(added, []);
  assert.equal(d.snapshot.items[0].state, 'queued');
  assert.equal(d.snapshot.items[0].waitReason, 'off');
});

test('with background downloads on, the queue is added and downloads', async () => {
  const { added, tick } = rig({ backgroundDownloads: true, queue: [{ id: 'q1', source: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), infoHash: 'a'.repeat(40), fileIndex: null, title: 'Film', paused: false, skipped: false }] });
  await tick();
  assert.equal(added.length, 1);
});

test('not sharing: a torrent nothing plays disconnects; the one playing stays', async () => {
  const idle = entry(1, 'b'.repeat(40));
  const playing = entry(2, 'c'.repeat(40));
  const { tick } = rig({ entries: [idle, playing], stream: { id: 7, entry: playing, file: playing.file, fileIndex: 0, durationSecs: null, startedAt: Date.now(), firstFrameMs: 10 } });
  await tick();
  assert.equal(idle.torrent.paused, true);
  assert.ok(idle.torrent.wires.every((w) => w.destroyed));
  assert.equal(playing.torrent.paused, false);
  assert.ok(playing.torrent.wires.every((w) => !w.destroyed));
});

test('sharing on: a half-watched torrent outside the queue keeps its peers', async () => {
  const idle = entry(1, 'd'.repeat(40));
  const { tick } = rig({ seedAfterWatching: true, entries: [idle] });
  await tick();
  assert.equal(idle.torrent.paused, false);
});

test('preloads and prefetches are left to look after themselves', async () => {
  const preload = { ...entry(1, 'e'.repeat(40)), claimed: false, origin: 'preload' };
  const { tick } = rig({ entries: [preload] });
  await tick();
  assert.equal(preload.torrent.paused, false);
});

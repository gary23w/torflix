// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Preloader } from '../src/main/preloader.js';
import { Library } from '../src/main/library.js';

const WATCHED = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const LENGTH = 4 * 1024 ** 3;

/** A preloader over a fake engine that records what it removes. */
function rig(library) {
  const removed = [];
  const engine = {
    // A fresh start of the app: the torrent is added again, as a preload nobody claimed yet.
    async add(_link, { infoHash }) {
      return { infoHash, origin: 'preload', claimed: false, torrent: { numPeers: 0 }, claim() {} };
    },
    files: () => [{ index: 0, path: 'Film.mkv', length: LENGTH, kind: 'video' }],
    file: () => ({ length: LENGTH, offset: 0, _torrent: { pieceLength: 1024 * 1024, pieces: { length: LENGTH / (1024 * 1024) } } }),
    async remove(entry, { destroyStore }) {
      removed.push({ infoHash: entry.infoHash, destroyStore });
    },
  };
  const settings = { settings: { playback: { warmUp: true }, search: { preloadTopResult: false } } };
  return { preloader: new Preloader({ engine, settings, library }), removed };
}

test('leaving a title page keeps the data of a film played before, and deletes a new one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-preload-'));
  const library = new Library(dir);
  library.opened({ infoHash: WATCHED, fileIndex: 0, source: `magnet:?xt=urn:btih:${WATCHED}`, title: 'Film', torrentName: 'Film' });
  const { preloader, removed } = rig(library);
  t.after(async () => {
    await preloader.destroy();
    await library.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const hash of [WATCHED, NEW]) {
    await preloader.preload({ link: `magnet:?xt=urn:btih:${hash}`, infoHash: hash, reason: 'title', owner: 'movie:film:', positionSecs: 265, durationSecs: 9421 });
    await preloader.cancel({ owner: 'movie:film:' });
  }
  assert.deepEqual(removed, [
    { infoHash: WATCHED, destroyStore: false },
    { infoHash: NEW, destroyStore: true },
  ]);
});

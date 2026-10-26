// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cache, diskBytes } from '../src/main/cache.js';

const MiB = 1024 * 1024;

function cacheOf(dir, { limitGb, open = [] }) {
  return new Cache({
    downloadDir: dir,
    engine: { entries: new Map(open.map((name, i) => [i, { torrent: { name } }])) },
    library: { queue: { items: [] } },
    settings: { settings: { storage: { cacheLimitGb: limitGb, cleanupAfterDays: null } } },
  });
}

/** A file `length` long with only its first `written` bytes on disk, as a partial download is. */
function sparseFile(file, length, written) {
  fs.writeFileSync(file, '');
  if (process.platform === 'win32') execFileSync('fsutil', ['sparse', 'setflag', file], { stdio: 'ignore' });
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(written, 1), 0, written, 0);
  fs.ftruncateSync(fd, length);
  fs.closeSync(fd);
}

test('a partial download counts what it holds, not its length, against the size limit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const film = path.join(dir, 'Film.2026.1080p.mkv');
  try {
    sparseFile(film, 3_000_000_000, MiB);
  } catch {
    return t.skip('no sparse files here');
  }
  if (diskBytes(fs.statSync(film)) >= 1_000_000_000) return t.skip('no sparse files here');
  // Nothing is open, as at start-up: only the limit decides.
  const cache = cacheOf(dir, { limitGb: 1 });
  assert.ok((await cache.usage()).bytes < 100 * MiB);
  await cache.enforce();
  assert.ok(fs.existsSync(film), 'a film watched for a while is kept, with its resume point');
});

test('over the limit, the oldest download nothing has open goes first', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['oldest.mkv', 'open.mkv', 'newer.mkv', 'newest.mkv'];
  names.forEach((name, i) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(2 * MiB, 1));
    const at = new Date(Date.now() - (names.length - i) * 60_000);
    fs.utimesSync(file, at, at);
  });
  // 8 MiB on disk, 5 MB allowed: the two oldest that are not open go.
  await cacheOf(dir, { limitGb: 0.005, open: ['open.mkv'] }).enforce();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['newest.mkv', 'open.mkv']);
});

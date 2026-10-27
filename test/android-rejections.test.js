// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/tracker-abort.js', import.meta.url));
const guard = new URL('../src/android/rejections.js', import.meta.url).href;

/** Runs Node in its own process, as the Android app runs the backend. */
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });

test('a tracker request aborted after its torrent is removed ends a process left unguarded', () => {
  const { status, stdout, stderr } = node([fixture]);
  // If this starts passing after an update of bittorrent-tracker, its bug may be fixed, and
  // src/android/rejections.js may no longer be needed.
  assert.equal(status, 1, 'the unguarded process survived');
  assert.doesNotMatch(stdout, /alive/);
  assert.match(stderr, /AbortError/);
});

test('the backend logs that aborted request and runs on', () => {
  const { status, stdout, stderr } = node([fixture, '--guarded']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /alive/);
  assert.match(stderr, /ignored an aborted request nobody awaited/);
});

test('any other unhandled rejection still ends the backend', () => {
  const script = `await import(${JSON.stringify(guard)}); Promise.reject(new Error('disk full'));`;
  const { status, stderr } = node(['--input-type=module', '--eval', script]);
  assert.equal(status, 1);
  assert.match(stderr, /disk full/);
  assert.doesNotMatch(stderr, /ignored an aborted request/);
});

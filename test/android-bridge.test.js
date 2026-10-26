// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toWire, fromWire, adaptIndex, hasToken } from '../src/android/bridge.js';

test('bytes cross the bridge as base64 and come back as a Uint8Array', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const sent = JSON.parse(JSON.stringify(toWire([{ name: 'x.torrent', value: bytes }, 3, 'a', null])));
  assert.deepEqual(sent[0].value, { $bytes: 'AAEC+v8=' });
  const back = fromWire(sent);
  assert.ok(back[0].value instanceof Uint8Array);
  assert.deepEqual([...back[0].value], [...bytes]);
  assert.deepEqual(back.slice(1), [3, 'a', null]);
});

test('a slice of a larger buffer sends only its own bytes', () => {
  const big = new Uint8Array([9, 9, 1, 2, 9]);
  assert.deepEqual(toWire(big.subarray(2, 4)), { $bytes: 'AQI=' });
});

test('an object that only looks like bytes keeps its other keys, and __proto__ stays a plain key', () => {
  assert.deepEqual(fromWire({ $bytes: 'AQI=', extra: 1 }), { $bytes: 'AQI=', extra: 1 });
  const parsed = fromWire(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__']);
});

test('the desktop page is adapted for the bridge: its own origin, and the shim before the app', () => {
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const adapted = adaptIndex(html);
  assert.match(adapted, /connect-src 'self'/);
  assert.doesNotMatch(adapted, /connect-src 'none'/);
  assert.ok(adapted.indexOf('../android/tp-shim.js') < adapted.indexOf('src="app.js"'));
  assert.throws(() => adaptIndex('<html></html>'));
});

test('only the token cookie opens the bridge', () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.equal(hasToken(`tp=${token}`, token), true);
  assert.equal(hasToken(`a=b; tp=${token}; c=d`, token), true);
  assert.equal(hasToken(`tp=${token.replace('0', '1')}`, token), false);
  assert.equal(hasToken(`xtp=${token}`, token), false);
  assert.equal(hasToken(undefined, token), false);
});

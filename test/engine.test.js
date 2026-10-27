// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardHandshake } from '../src/main/engine.js';

test('a destroyed peer whose encrypted handshake finishes late sends nothing, instead of crashing', async () => {
  const { default: Peer } = await import('webtorrent/lib/peer.js');
  const destroyed = Object.assign(Object.create(Peer.prototype), { swarm: null, wire: null });
  guardHandshake(Peer);
  guardHandshake(Peer);
  assert.equal(Peer.prototype.handshake.guarded, true);
  assert.doesNotThrow(() => destroyed.handshake());
  // A live peer still shakes hands.
  const sent = [];
  const live = Object.assign(Object.create(Peer.prototype), {
    swarm: { private: false, client: { dht: {}, peerId: 'p' }, infoHash: 'h' },
    wire: { handshake: (...args) => sent.push(args) },
  });
  live.handshake();
  assert.equal(sent.length, 1);
  assert.equal(live.sentHandshake, true);
});

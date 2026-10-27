// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dialWide, MseKeys, quickConnect, quickKeys, quickRamp, recentRate } from '../src/main/swarm.js';

const MSE_PRIME_HEX =
  'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a36210000000000090563';

test('an outgoing connection that does not open soon is given up; other kinds keep their wait', async (t) => {
  const { default: Peer } = await import('webtorrent/lib/peer.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  quickConnect(Peer, 2000);
  quickConnect(Peer, 2000);
  assert.equal(Peer.prototype.startConnectTimeout.quick, true);
  const peer = (type) => {
    const p = Object.assign(Object.create(Peer.prototype), { type, destroyed: false });
    p.destroy = (err) => (p.gaveUp = err.message);
    return p;
  };
  const tcp = peer('tcpOutgoing');
  const utp = peer('utpOutgoing');
  const webrtc = peer('webrtc');
  for (const p of [tcp, utp, webrtc]) p.startConnectTimeout();
  t.mock.timers.tick(1999);
  assert.equal(tcp.gaveUp, undefined);
  t.mock.timers.tick(1);
  assert.equal(tcp.gaveUp, 'connect timeout');
  assert.equal(utp.gaveUp, 'connect timeout');
  assert.equal(webrtc.gaveUp, undefined);
  t.mock.timers.tick(30_000);
  assert.equal(webrtc.gaveUp, 'connect timeout');
});

test('a torrent dials many queued peers at once, and stops at the peer limit or the attempt limit', () => {
  // WebTorrent's own _drain: one queued peer per call, counted as pending until it answers.
  const torrent = {
    destroyed: false,
    paused: false,
    _numConns: 0,
    _numPending: 0,
    _queue: Array.from({ length: 100 }, (_, i) => `peer${i}`),
    dialed: [],
    _drain() {
      const peer = this._queue.shift();
      if (!peer) return;
      this.dialed.push(peer);
      this._numPending += 1;
    },
  };
  let limit = 40;
  dialWide(torrent, () => limit, 25);
  dialWide(torrent, () => limit, 25);
  torrent._drain();
  assert.equal(torrent.dialed.length, 25);
  // Answers: two connect, one fails (WebTorrent then drains again).
  torrent._numPending -= 3;
  torrent._numConns += 2;
  torrent._drain();
  assert.equal(torrent.dialed.length, 28);
  assert.equal(torrent._numPending, 25);
  // At the peer limit nothing more is dialed, however many attempts are free.
  torrent._numPending = 0;
  torrent._numConns = 40;
  torrent._drain();
  assert.equal(torrent.dialed.length, 28);
  limit = 41;
  torrent._drain();
  assert.equal(torrent.dialed.length, 53);
  // A paused torrent dials no one.
  torrent._numPending = 0;
  torrent.paused = true;
  torrent._drain();
  assert.equal(torrent.dialed.length, 53);
});

test('the last second rate counts what arrived in the last second only', () => {
  let t = 10_000;
  const rate = recentRate(1000, () => t);
  assert.equal(rate(), 0);
  rate(16384);
  t += 250;
  rate(16384);
  assert.equal(rate(), 32768);
  t += 800; // the first block is over a second old now
  assert.equal(rate(), 16384);
  t += 5000;
  assert.equal(rate(), 0);
  rate(1000);
  assert.equal(rate(), 1000);
});

test('a peer that starts sending fast reads fast at once; one that stalls reads slow again', () => {
  let t = 50_000;
  const realNow = Date.now;
  Date.now = () => t;
  try {
    // The wire's own meter (bittorrent-protocol's): everything over its life so far, 5 s here.
    let total = 0;
    const wire = { downloadSpeed: (delta) => ((total += delta ?? 0), total / 5) };
    quickRamp(wire);
    quickRamp(wire);
    assert.equal(wire.downloadSpeed.quick, true);
    // 1 MiB in the last moment, after the peer sat idle: about 200 KiB/s by its own meter.
    for (let i = 0; i < 64; i++) wire.downloadSpeed(16384);
    assert.equal(wire.downloadSpeed(), 1024 * 1024);
    // Nothing since: the wire's own (slow) meter again.
    t += 3000;
    assert.equal(wire.downloadSpeed(), (1024 * 1024) / 5);
  } finally {
    Date.now = realNow;
  }
});

test('the quick key exchange agrees with Node’s Diffie-Hellman over the MSE prime, both ways', () => {
  for (let i = 0; i < 4; i++) {
    const node = crypto.createDiffieHellman(MSE_PRIME_HEX, 'hex', 2);
    const nodePublic = node.generateKeys();
    const quick = new MseKeys();
    const quickPublic = quick.generateKeys();
    assert.equal(quickPublic.length, 96);
    // The same key each time it is asked for, as Node's does.
    assert.equal(quick.generateKeys(), quickPublic);
    const ours = quick.computeSecret(nodePublic);
    const theirs = node.computeSecret(quickPublic);
    assert.equal(ours.length, 96);
    assert.equal(ours.toString('hex'), theirs.toString('hex'));
  }
  // Two quick ones agree too, and differ from another pair.
  const [a, b, c] = [new MseKeys(), new MseKeys(), new MseKeys()];
  assert.deepEqual(a.computeSecret(b.generateKeys()), b.computeSecret(a.generateKeys()));
  assert.notDeepEqual(a.computeSecret(b.generateKeys()), a.computeSecret(c.generateKeys()));
});

test('two wires finish an encrypted handshake with the quick key exchange', async () => {
  const { default: Wire } = await import('bittorrent-protocol');
  assert.equal(quickKeys(Wire), true);
  assert.equal(quickKeys(Wire), true);
  const infoHash = crypto.randomBytes(20).toString('hex');
  const peerA = crypto.randomBytes(20).toString('hex');
  const peerB = crypto.randomBytes(20).toString('hex');
  const outgoing = new Wire('tcpOutgoing', 1);
  const incoming = new Wire('tcpIncoming', 1);
  assert.ok(outgoing._encryptor.dh instanceof MseKeys);
  outgoing.pipe(incoming).pipe(outgoing);
  const done = Promise.all([
    new Promise((resolve) => outgoing.once('handshake', (hash, id) => resolve({ hash, id }))),
    new Promise((resolve) => incoming.once('handshake', (hash, id) => resolve({ hash, id }))),
  ]);
  // What WebTorrent does: the incoming side learns which torrent from the encrypted hash.
  incoming.once('crypto-infohash', () => {
    incoming.setInfoHash(infoHash);
  });
  incoming.once('handshake', () => incoming.handshake(infoHash, peerB));
  outgoing.once('crypto-handshake', () => outgoing.handshake(infoHash, peerA));
  outgoing.startEncryption(infoHash);
  let timer;
  const [atOutgoing, atIncoming] = await Promise.race([done, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('handshake timed out')), 5000)))]);
  clearTimeout(timer);
  assert.equal(atOutgoing.hash, infoHash);
  assert.equal(atOutgoing.id, peerB);
  assert.equal(atIncoming.hash, infoHash);
  assert.equal(atIncoming.id, peerA);
  assert.ok(incoming._encryptor.dh instanceof MseKeys);
  outgoing.destroy();
  incoming.destroy();
});

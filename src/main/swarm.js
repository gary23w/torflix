// SPDX-License-Identifier: MIT OR Apache-2.0
//
// How quickly a torrent gets going: reaching peers, shaking hands with them, and asking them
// for enough at once. WebTorrent's defaults suit a fast computer and a healthy swarm; measured
// on the TV box (armv7) and on a PC, a magnet link took 7 to 17 s to find its first peer and
// the first piece trickled in long after. Each change here is a small patch to WebTorrent or
// bittorrent-protocol, applied once (engine.js).

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * How long an outgoing connection to a peer may take to open. WebTorrent waits 5 s, but most
 * peers a public swarm announces are unreachable (behind NAT): about 19 attempts in 20 never
 * answered, while nine in ten of those that did opened within 0.6 s, on a PC and on the TV box
 * alike (over Wi-Fi). Each unanswered attempt held a connection slot for the whole wait.
 * With `PENDING_CONNECTS` this dials up to 30 peers a second, libtorrent's default rate: faster
 * would fill a home router's table of half-open connections.
 */
export const CONNECT_TIMEOUT_MS = 2000;
/**
 * Connection attempts a torrent keeps open at once, on top of its connected peers (the peer
 * limit counts only those). An unanswered attempt costs next to nothing, so many at once find
 * the few reachable peers sooner.
 */
export const PENDING_CONNECTS = 60;
/** The window of the rate a peer's requests follow (quickRamp). */
const RAMP_WINDOW_MS = 1000;

/** Outgoing connections give up after `CONNECT_TIMEOUT_MS`, not WebTorrent's 5 s. */
export function quickConnect(Peer, ms = CONNECT_TIMEOUT_MS) {
  const start = Peer.prototype.startConnectTimeout;
  if (typeof start !== 'function' || start.quick) return;
  Peer.prototype.startConnectTimeout = function quickConnectTimeout() {
    if (this.type !== 'tcpOutgoing' && this.type !== 'utpOutgoing') return start.call(this);
    clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => this.destroy(new Error('connect timeout')), ms);
    this.connectTimeout.unref?.();
  };
  Peer.prototype.startConnectTimeout.quick = true;
}

/**
 * Dials a torrent's queued peers up to `PENDING_CONNECTS` at a time while fewer than the peer
 * limit are connected. WebTorrent counts attempts against the limit, and starts one per event
 * (a peer found, a peer gone), so a burst of unreachable peers filled every slot for seconds.
 * The client's own limit must leave room for the attempts (engine.js).
 */
export function dialWide(torrent, peerLimit, pending = PENDING_CONNECTS) {
  const drain = torrent?._drain;
  if (typeof drain !== 'function' || drain.wide) return;
  torrent._drain = function wideDrain() {
    for (;;) {
      if (this.destroyed || this.paused || !this._queue?.length) return;
      if (this._numConns >= peerLimit() || this._numPending >= pending) return;
      const before = this._numPending;
      drain.call(this);
      if (this._numPending === before) return;
    }
  };
  torrent._drain.wide = true;
}

/**
 * Lets a peer that sends fast be asked for more at once within a few round trips. WebTorrent
 * keeps about one second of a peer's measured rate in requests, but measures it over the
 * peer's whole life (up to 5 s), the wait before it sent anything included, so a new peer was
 * asked for two blocks at a time and the first piece trickled in from peers able to send it in
 * a moment. The rate it reads is now also the last second's; a peer that stalls still reads slow.
 */
export function quickRamp(wire, windowMs = RAMP_WINDOW_MS) {
  const measured = wire?.downloadSpeed;
  if (typeof measured !== 'function' || measured.quick) return;
  const recent = recentRate(windowMs);
  wire.downloadSpeed = (delta) => Math.max(measured(delta), recent(delta));
  wire.downloadSpeed.quick = true;
}

/** Bytes per second over the last `windowMs` (kept in ten slots): `(delta)` adds bytes, `()` reads. */
export function recentRate(windowMs, now = () => Date.now()) {
  const slots = 10;
  const slotMs = windowMs / slots;
  const counts = new Array(slots).fill(0);
  let at = Math.floor(now() / slotMs);
  return (delta) => {
    const tick = Math.floor(now() / slotMs);
    for (let t = at + 1; t <= Math.min(tick, at + slots); t++) counts[t % slots] = 0;
    at = Math.max(at, tick);
    if (delta) counts[at % slots] += delta;
    let sum = 0;
    for (const c of counts) sum += c;
    return (sum * 1000) / windowMs;
  };
}

/** The prime of BitTorrent's protocol encryption (MSE), as bittorrent-protocol has it; the generator is 2. */
const MSE_PRIME = BigInt(
  '0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a36210000000000090563',
);
const MSE_KEY_BYTES = 96;

/**
 * The key exchange of an encrypted peer connection, the way bittorrent-protocol's encryptor
 * uses Node's DiffieHellman (`generateKeys()`, `computeSecret(theirs)`). Node checks that the
 * prime is a safe prime every time one is made: 0.7 s of the TV box's processor for each peer
 * that connects (15 ms on a PC), during which nothing else runs, and the engine sat at a full
 * core while it kept a swarm connected. Here a key costs about 5 ms there. The private key is
 * 160 bits, as the MSE specification asks (Node used 767).
 */
export class MseKeys {
  constructor() {
    this.x = BigInt(`0x${crypto.randomBytes(20).toString('hex')}`) | (1n << 159n);
    this.publicKey = null;
  }

  generateKeys() {
    this.publicKey ??= toKeyBytes(modPow(2n, this.x));
    return this.publicKey;
  }

  computeSecret(theirs) {
    return toKeyBytes(modPow(BigInt(`0x${Buffer.from(theirs).toString('hex') || '0'}`), this.x));
  }
}

function modPow(base, exp) {
  let result = 1n;
  let b = base % MSE_PRIME;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % MSE_PRIME;
    b = (b * b) % MSE_PRIME;
  }
  return result;
}

/** Big-endian and zero-padded to the prime's length, as Node returns both keys and secrets. */
function toKeyBytes(n) {
  return Buffer.from(n.toString(16).padStart(MSE_KEY_BYTES * 2, '0'), 'hex');
}

/**
 * Every encrypted connection's key exchange uses `MseKeys`. bittorrent-protocol does not export
 * its encryptor, so it is reached through a wire's own (made and dropped at once).
 */
export function quickKeys(Wire) {
  let encryptor = null;
  try {
    const wire = new Wire('tcpOutgoing', 1);
    encryptor = wire._encryptor;
    wire.destroy();
  } catch {
    return false;
  }
  const proto = encryptor ? Object.getPrototypeOf(encryptor) : null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'dh') : null;
  if (!desc?.get) return false;
  if (desc.get.quick) return true;
  const get = function dh() {
    this._dh ??= new MseKeys();
    return this._dh;
  };
  get.quick = true;
  Object.defineProperty(proto, 'dh', { ...desc, get });
  return true;
}

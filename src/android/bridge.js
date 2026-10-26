// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The parts of the Android bridge (backend.js) that are plain functions: how values cross it,
// and how the desktop page is adapted to it.
//
// Electron IPC carries bytes as they are; JSON does not, so every Uint8Array (a .torrent file,
// a subtitle file, a dropped torrent) travels as `{ "$bytes": "<base64>" }` and is turned back
// into a Uint8Array on the other side. The renderer's half is in tp-shim.js.

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

/** A copy of `value` that JSON can carry: bytes become `{ $bytes }`. */
export function toWire(value) {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  return value;
}

/** The value `toWire` (or the renderer) sent: `{ $bytes }` becomes a Uint8Array again. */
export function fromWire(value) {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$bytes' && typeof value.$bytes === 'string') return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
    // fromEntries defines own properties, so a "__proto__" key stays a plain key.
    return Object.fromEntries(keys.map((k) => [k, fromWire(value[k])]));
  }
  return value;
}

/**
 * The desktop page, adapted for the bridge: the page may now talk to its own origin (the
 * commands and events), and the shim that provides `window.tp` loads before the app.
 */
export function adaptIndex(html) {
  const csp = html.replace(/connect-src 'none'/, "connect-src 'self'");
  const shimmed = csp.replace(/<script type="module"/, '<script src="../android/tp-shim.js"></script>\n    <script type="module"');
  if (csp === html || shimmed === csp) throw new Error('index.html no longer has the CSP or module script the bridge adapts');
  return shimmed;
}

/** Whether a Cookie header carries the bridge's token (32 hex characters). */
export function hasToken(cookie, token) {
  const m = /(?:^|;\s*)tp=([0-9a-f]{32})(?:;|$)/.exec(cookie ?? '');
  return Boolean(m) && token.length === 32 && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
}

// SPDX-License-Identifier: MIT OR Apache-2.0
// Browser-style history over small view descriptors: `{ view: 'search', searchId }`,
// `{ view: 'files', torrentId }`, `{ view: 'title', key }`, `{ view: 'player' }`, ... Each
// search and each title is its own entry, so Back moves between them.

import { Emitter } from './state.js';

export const VIEWS = ['browse', 'title', 'search', 'open', 'library', 'files', 'player', 'settings'];
const MAX_ENTRIES = 100;

export class Nav extends Emitter {
  constructor(initial = { view: 'search', searchId: null }) {
    super();
    this.entries = [initial];
    this.at = 0;
  }

  get current() {
    return this.entries[this.at];
  }

  get canBack() {
    return this.at > 0;
  }

  get canForward() {
    return this.at < this.entries.length - 1;
  }

  /** Goes to a view; an entry equal to the current one is not duplicated. */
  go(entry) {
    const cur = this.current;
    if (same(cur, entry)) return;
    this.entries = this.entries.slice(0, this.at + 1);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.at = this.entries.length - 1;
    this.emit('change', this.current, 'push');
  }

  /** Replaces the current entry (for example when a search gets its id). */
  replace(entry) {
    this.entries[this.at] = entry;
    this.emit('change', this.current, 'replace');
  }

  back() {
    if (!this.canBack) return;
    this.at -= 1;
    this.emit('change', this.current, 'back');
  }

  forward() {
    if (!this.canForward) return;
    this.at += 1;
    this.emit('change', this.current, 'forward');
  }

  /** Drops entries for searches that were forgotten. */
  forgetSearches(ids) {
    const drop = new Set(ids);
    const kept = [];
    let newAt = this.at;
    this.entries.forEach((e, i) => {
      if (e.view === 'search' && e.searchId !== null && drop.has(e.searchId)) {
        if (i <= this.at) newAt -= 1;
        return;
      }
      kept.push(e);
    });
    if (kept.length === 0) kept.push({ view: 'search', searchId: null });
    this.entries = kept;
    this.at = Math.max(0, Math.min(newAt, kept.length - 1));
  }
}

export function same(a, b) {
  return a.view === b.view && (a.searchId ?? null) === (b.searchId ?? null) && (a.torrentId ?? null) === (b.torrentId ?? null) && (a.key ?? null) === (b.key ?? null);
}

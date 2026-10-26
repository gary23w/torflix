// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The play queue: a playlist with a cursor. Pure functions over `{ items, current, order }`;
// the shell saves the result through the backend, which downloads it in the background.
// A torrent's queued files stay together (its group), and new files join their group.

import { uid } from './dom.js';

export function groupKey(item) {
  return item.infoHash ?? item.source;
}

export function makeItem({ source, infoHash = null, fileIndex = null, title, torrentName = null, sizeBytes = null }) {
  return { id: uid(), source, infoHash, fileIndex, title, torrentName, sizeBytes, paused: false, skipped: false, played: false };
}

/**
 * The queued item for a file, if any. A request for a torrent's main video (`fileIndex`
 * null) matches an item queued the same way, or else the torrent's first queued file, so
 * pressing Play on a result twice never queues it twice.
 */
export function findItem(queue, { infoHash, source, fileIndex }) {
  const sameTorrent = (i) => (infoHash && i.infoHash ? i.infoHash === infoHash : i.source === source || (infoHash !== null && infoHash !== undefined && i.infoHash === infoHash));
  const want = fileIndex ?? null;
  const exact = queue.items.find((i) => sameTorrent(i) && (i.fileIndex ?? null) === want);
  if (exact || want !== null) return exact ?? null;
  return queue.items.find((i) => sameTorrent(i)) ?? null;
}

/** Adds items; files of a torrent already queued join it right after its last file. */
export function enqueue(queue, newItems) {
  const items = [...queue.items];
  const added = [];
  for (const it of newItems) {
    if (findItem({ items }, it)) continue;
    const key = groupKey(it);
    let at = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (groupKey(items[i]) === key) {
        at = i;
        break;
      }
    }
    if (at >= 0) items.splice(at + 1, 0, it);
    else items.push(it);
    added.push(it);
  }
  return { queue: { ...queue, items }, added };
}

/** Queue items grouped by torrent, in order of first appearance. */
export function groups(queue) {
  const map = new Map();
  for (const item of queue.items) {
    const key = groupKey(item);
    if (!map.has(key)) map.set(key, { key, name: item.torrentName ?? item.title, items: [] });
    map.get(key).items.push(item);
  }
  return [...map.values()];
}

export function currentItem(queue) {
  return queue.items.find((i) => i.id === queue.current) ?? null;
}

/** The item to play after `id` (the current one by default): the next not skipped. */
export function nextItem(queue, id = queue.current) {
  const at = id === null ? -1 : queue.items.findIndex((i) => i.id === id);
  for (let i = at + 1; i < queue.items.length; i++) if (!queue.items[i].skipped) return queue.items[i];
  return null;
}

export function previousItem(queue, id = queue.current) {
  const at = id === null ? queue.items.length : queue.items.findIndex((i) => i.id === id);
  for (let i = at - 1; i >= 0; i--) if (!queue.items[i].skipped) return queue.items[i];
  return null;
}

/** Items after the current one that are not skipped. */
export function upcoming(queue) {
  const at = queue.current === null ? -1 : queue.items.findIndex((i) => i.id === queue.current);
  return queue.items.slice(at + 1).filter((i) => !i.skipped);
}

export function setCurrent(queue, id) {
  return { ...queue, current: id };
}

export function patchItem(queue, id, patch) {
  return { ...queue, items: queue.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}

export function markPlayed(queue, id) {
  return patchItem(queue, id, { played: true });
}

export function removeItems(queue, ids) {
  const drop = new Set(ids);
  return { ...queue, items: queue.items.filter((i) => !drop.has(i.id)), current: drop.has(queue.current) ? null : queue.current };
}

export function clearPlayed(queue) {
  return removeItems(
    queue,
    queue.items.filter((i) => i.played && i.id !== queue.current).map((i) => i.id),
  );
}

export function clearAll(queue) {
  return { ...queue, items: [], current: null };
}

/** Moves an item up (-1) or down (+1) within its torrent's group. */
export function moveItem(queue, id, delta) {
  const items = [...queue.items];
  const at = items.findIndex((i) => i.id === id);
  if (at < 0) return queue;
  const to = at + delta;
  if (to < 0 || to >= items.length) return queue;
  if (groupKey(items[to]) !== groupKey(items[at])) return moveGroup(queue, groupKey(items[at]), delta);
  [items[at], items[to]] = [items[to], items[at]];
  return { ...queue, items };
}

/** Moves a whole torrent before the previous group or after the next one. */
export function moveGroup(queue, key, delta) {
  const gs = groups(queue);
  const at = gs.findIndex((g) => g.key === key);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= gs.length) return queue;
  [gs[at], gs[to]] = [gs[to], gs[at]];
  return { ...queue, items: gs.flatMap((g) => g.items) };
}

/** Where a torrent's file stands: playing, up next, queued, or null. */
export function entryState(queue, { infoHash, source, fileIndex }) {
  const it = findItem(queue, { infoHash, source, fileIndex });
  if (!it) return null;
  if (it.id === queue.current) return 'playing';
  const next = nextItem(queue);
  if (next && next.id === it.id) return 'upNext';
  return 'queued';
}

/**
 * "Play ready videos first": moves ready torrents (and, without `keepCourseOrder`, ready
 * files within a torrent) ahead of the rest, never moving played items, the item playing,
 * or the rest of its torrent. Returns the new queue, or null when nothing moves.
 */
export function optimize(queue, readiness, keepCourseOrder) {
  const ready = new Set(readiness.filter((r) => r.state !== 'waiting').map((r) => r.id));
  const currentKey = queue.current ? groupKey(currentItem(queue) ?? {}) : null;
  const gs = groups(queue);
  const at = queue.current === null ? -1 : gs.findIndex((g) => g.items.some((i) => i.id === queue.current));
  const fixed = gs.slice(0, at + 1);
  const rest = gs.slice(at + 1);
  const isReadyGroup = (g) => g.items.some((i) => !i.played && !i.skipped && ready.has(i.id));
  const movable = rest.filter((g) => g.key !== currentKey && !g.items.every((i) => i.played));
  const stay = rest.filter((g) => !movable.includes(g));
  const sorted = [...movable.filter(isReadyGroup), ...movable.filter((g) => !isReadyGroup(g))];
  const newGroups = [...fixed, ...sorted, ...stay].map((g) => {
    if (keepCourseOrder || g.key === currentKey) return g;
    const readyItems = g.items.filter((i) => ready.has(i.id) && !i.played);
    const others = g.items.filter((i) => !readyItems.includes(i));
    return { ...g, items: [...readyItems, ...others] };
  });
  const items = newGroups.flatMap((g) => g.items);
  if (items.every((it, i) => it.id === queue.items[i]?.id)) return null;
  return { ...queue, items };
}

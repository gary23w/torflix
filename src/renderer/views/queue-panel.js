// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The queue beside the player: torrents as collapsible groups, each file with a tick (queued
// or skipped), its state, and a live download line and bar. The ⋯ menu holds the queue-wide
// actions; In order / Fastest first chooses how spare bandwidth is shared.

import { h, icon, ICONS, replace, closeOnOutside } from '../lib/dom.js';
import { formatRate, formatEtaLong } from '../../shared/format.js';
import { groups, nextItem } from '../lib/queue.js';

/** One line about an item's download, or what it waits for. */
export function describeDownload(d) {
  const parts = [];
  const pct = d.length ? `${Math.floor(Math.min(1, d.downloaded / d.length) * 100)}%` : null;
  const peers = (n) => `${n} ${n === 1 ? 'peer' : 'peers'}`;
  switch (d.state) {
    case 'downloading':
    case 'watching': {
      parts.push(`↓ ${formatRate(d.downloadBps)}`, peers(d.peersLive));
      if (pct) parts.push(pct);
      const eta = formatEtaLong(d.etaSecs);
      if (eta) parts.push(`${eta} left`);
      if (d.limited && d.state === 'downloading') parts.push('slowed for playback');
      break;
    }
    case 'complete':
      parts.push('Downloaded');
      break;
    case 'connecting':
      parts.push(d.peersSeen > 0 ? `Connecting to peers (${d.peersSeen} found)` : 'Finding peers…');
      if (pct && d.downloaded > 0) parts.push(pct);
      break;
    case 'starting':
      parts.push('Starting…');
      break;
    case 'queued':
      parts.push(d.waitReason === 'off' ? 'Downloads when played' : d.waitReason === 'playback' ? 'Paused while the video playing catches up' : d.waitReason === 'limit' ? 'Waiting: your limit of downloads at once' : 'Waiting');
      if (pct && d.downloaded > 0) parts.push(pct);
      break;
    case 'skipped':
      if (pct && d.downloaded > 0) parts.push(`${pct} downloaded`);
      break;
    case 'paused':
      parts.push('Paused');
      if (pct && d.downloaded > 0) parts.push(pct);
      break;
    case 'failed':
      parts.push(d.error === null ? 'Could not start; trying again soon' : `${d.error} Trying again soon.`);
      break;
    default:
      break;
  }
  if (d.uploadBps > 0) parts.push(`↑ ${formatRate(d.uploadBps)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

export function toneOf(d) {
  if (d.startable || d.state === 'complete' || d.state === 'watching') return 'playable';
  if (d.state === 'downloading' && d.peersLive > 0) return 'downloading';
  return 'waiting';
}

export function describeLink(link) {
  if (!link || (link.capacityBps === 0 && link.usedBps === 0 && link.active === 0)) return null;
  const parts = [];
  if (link.capacityBps > 0) parts.push(`Connection ≈ ${formatRate(link.capacityBps)}`);
  parts.push(`${formatRate(link.usedBps)} in use`);
  if (link.active > 0) parts.push(link.maxActive === null ? `${link.active} downloading` : `${link.active} of max ${link.maxActive} downloading`);
  if (link.playbackNeedBps !== null) parts.push(link.pressure === 'starving' ? 'queue paused for playback' : link.pressure === 'guarded' ? 'playback first' : 'playback has enough');
  return parts.join(' · ');
}

export function fastestItem(items) {
  const moving = items.filter((d) => d.state === 'downloading' && d.downloadBps > 0).sort((a, b) => b.downloadBps - a.downloadBps);
  const [first, second] = moving;
  if (!first || !second) return null;
  return first.downloadBps >= second.downloadBps * 1.5 ? first.id : null;
}

export class QueuePanel {
  constructor(root, { onPlay, onChange, onCollapse, settings, onSettings, onMove, isPlaying }) {
    this.root = root;
    this.onPlay = onPlay;
    this.onChange = onChange;
    this.onCollapse = onCollapse;
    this.settings = settings;
    this.onSettings = onSettings;
    this.onMove = onMove;
    this.isPlaying = isPlaying;
    this.queue = { items: [], current: null, order: 'inOrder' };
    this.downloads = { items: [], link: null };
    this.collapsed = new Set();
    this.menuOpen = false;
    this.rows = new Map();
    this.render();
  }

  setQueue(queue) {
    this.queue = queue;
    this.renderList();
    this.renderOrder();
  }

  setDownloads(snapshot) {
    this.downloads = snapshot;
    this.renderLink();
    this.updateRows();
  }

  render() {
    this.orderEl = h('div.segmented', { role: 'group', 'aria-label': 'Download order' });
    this.linkEl = h('p.link-summary', { 'aria-live': 'polite' });
    this.listEl = h('div.queue-list');
    this.menuEl = h('div.menu');
    replace(
      this.root,
      h(
        'div.queue-head',
        null,
        h('h2', null, 'Queue'),
        this.menuEl,
        h('button.btn.icon-btn', { type: 'button', title: 'Hide the queue (Q)', 'aria-label': 'Hide the queue', onclick: this.onCollapse }, icon(ICONS.chevronLeft, { size: 16 })),
      ),
      this.orderEl,
      this.linkEl,
      this.listEl,
    );
    this.renderMenu();
    this.renderOrder();
    this.renderList();
  }

  renderMenu() {
    const btn = h('button.btn.icon-btn', { type: 'button', title: 'Queue options', 'aria-haspopup': 'menu', 'aria-expanded': this.menuOpen ? 'true' : 'false', onclick: () => this.toggleMenu() }, icon(ICONS.more, { size: 16 }));
    const s = this.settings();
    const item = (label, onclick, { checked = null, disabled = false } = {}) =>
      h('li', { role: 'none' }, h('button', { type: 'button', role: 'menuitem', disabled, onclick: () => (this.toggleMenu(false), onclick()) }, h('span', null, label), checked === null ? null : h('span.detail', null, checked ? 'On' : 'Off')));
    const popup = this.menuOpen
      ? h(
          'ul.popup.down.right',
          { role: 'menu' },
          item('Play ready videos first', () => this.onSettings({ playback: { optimizeQueue: !s.playback.optimizeQueue } }), { checked: s.playback.optimizeQueue }),
          item('Keep course order', () => this.onSettings({ playback: { keepCourseOrder: !s.playback.keepCourseOrder } }), { checked: s.playback.keepCourseOrder }),
          h('li.divider', { role: 'none' }),
          item('Clear played', () => this.onChange('clearPlayed'), { disabled: !this.queue.items.some((i) => i.played && i.id !== this.queue.current) }),
          item('Clear all', () => this.onChange('clearAll'), { disabled: this.queue.items.length === 0 }),
        )
      : null;
    replace(this.menuEl, btn, popup);
    if (popup) closeOnOutside(this.menuEl, () => this.toggleMenu(false));
  }

  toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    this.renderMenu();
  }

  renderOrder() {
    const seg = (value, label, title) => h('button', { type: 'button', class: this.queue.order === value ? 'on' : '', 'aria-pressed': this.queue.order === value ? 'true' : 'false', title, onclick: () => this.onChange('order', value) }, label);
    replace(this.orderEl, seg('inOrder', 'In order', 'Download the queue in order'), seg('fastest', 'Fastest first', 'Give the fastest torrents the bandwidth first'));
  }

  renderLink() {
    this.linkEl.textContent = describeLink(this.downloads.link) ?? '';
  }

  renderList() {
    // Rows are drawn anew: keyboard or remote focus goes back to the same row, or the same
    // button in it.
    const active = this.listEl.contains(document.activeElement) ? document.activeElement : null;
    const row = active?.closest('[data-id]');
    const spot = row ? { id: row.dataset.id, button: [...row.querySelectorAll('button')].indexOf(active) } : null;
    this.drawList();
    if (!spot) return;
    const li = this.rows.get(spot.id)?.li;
    const target = spot.button >= 0 ? li?.querySelectorAll('button')[spot.button] : li;
    target?.focus({ preventScroll: true });
  }

  drawList() {
    this.rows.clear();
    const q = this.queue;
    if (q.items.length === 0) {
      return replace(this.listEl, h('p.queue-empty', null, 'Nothing queued. Pick something from a search, or open a torrent, and press Queue.'));
    }
    const next = nextItem(q);
    const gs = groups(q);
    const tree = h('ul', { role: 'tree', 'aria-label': 'Queue' });
    for (const g of gs) {
      if (g.items.length === 1) {
        tree.append(this.renderItem(g.items[0], next, false));
        continue;
      }
      const collapsed = this.collapsed.has(g.key);
      const played = g.items.filter((i) => i.played).length;
      const node = h(
        'li.q-group',
        { class: collapsed ? 'collapsed' : '', role: 'treeitem', 'aria-expanded': collapsed ? 'false' : 'true' },
        h(
          'button.q-group-head',
          {
            type: 'button',
            onclick: () => {
              if (this.collapsed.has(g.key)) this.collapsed.delete(g.key);
              else this.collapsed.add(g.key);
              this.renderList();
            },
          },
          h('span.chev', null, icon(ICONS.chevronDown, { size: 14 })),
          h('span.name', { title: g.name }, g.name),
          h('span.count', null, `${played}/${g.items.length}`),
        ),
        h('ul.q-items.nested', { role: 'group' }, g.items.map((it) => this.renderItem(it, next, true))),
      );
      tree.append(node);
    }
    replace(this.listEl, tree);
    this.updateRows();
  }

  renderItem(it, next, nested) {
    const q = this.queue;
    const isCurrent = it.id === q.current;
    const playing = isCurrent && this.isPlaying();
    const state = playing ? 'Playing' : isCurrent ? (it.played ? 'Played' : 'Last played') : it.skipped ? 'Skipped' : it.paused ? 'Paused' : next && next.id === it.id ? 'Up next' : it.played ? 'Played' : null;
    const line = h('span.line');
    const bar = h('div.bar');
    const progress = h('div.progress', null, bar);
    const pauseBtn = h(
      'button.btn.icon-btn',
      { type: 'button', title: it.paused ? 'Resume downloading' : 'Pause downloading', 'aria-label': it.paused ? 'Resume downloading' : 'Pause downloading', onclick: () => this.onChange('paused', it.id, !it.paused) },
      icon(it.paused ? ICONS.play : ICONS.pause, { size: 13 }),
    );
    const li = h(
      'li.q-item',
      {
        class: [isCurrent ? 'current' : '', it.skipped ? 'skipped' : '', it.played ? 'played' : ''].join(' '),
        role: 'treeitem',
        tabindex: '0',
        'aria-selected': isCurrent ? 'true' : 'false',
        dataset: { id: it.id },
        onkeydown: (e) => this.onKey(e, it),
      },
      h('input.tick', { type: 'checkbox', checked: !it.skipped, title: it.skipped ? 'Queue it again' : 'Skip it (keeps it in the list)', 'aria-label': `Queue ${it.title}`, onchange: (e) => this.onChange('skipped', it.id, !e.target.checked) }),
      h(
        'div.body',
        null,
        h('button.title', { type: 'button', title: `Play ${it.title}`, onclick: () => this.onPlay(it) }, isCurrent ? h('span.play-mark', null, icon(ICONS.play, { size: 11, cls: 'fill' })) : null, h('span', null, it.title)),
        state ? h('span.state', { class: playing ? 'playing' : '' }, state) : null,
        line,
        progress,
      ),
      h(
        'div.side',
        null,
        pauseBtn,
        h('button.btn.icon-btn', { type: 'button', title: 'Remove from the queue', 'aria-label': 'Remove from the queue', onclick: () => this.onChange('remove', it.id) }, icon(ICONS.close, { size: 13 })),
      ),
    );
    if (nested) li.classList.add('nested');
    this.rows.set(it.id, { li, line, bar, progress, pauseBtn, item: it });
    return li;
  }

  onKey(e, it) {
    const q = this.queue;
    const ids = q.items.map((i) => i.id);
    const at = ids.indexOf(it.id);
    const focusRow = (id) => this.rows.get(id)?.li.focus();
    if (e.key === 'Enter') {
      e.preventDefault();
      this.onPlay(it);
    } else if (e.key === ' ') {
      e.preventDefault();
      this.onChange('skipped', it.id, !it.skipped);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.onChange('remove', it.id);
    } else if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      this.onMove(it.id, +1);
      setTimeout(() => focusRow(it.id), 0);
    } else if (e.key === 'ArrowUp' && e.altKey) {
      e.preventDefault();
      this.onMove(it.id, -1);
      setTimeout(() => focusRow(it.id), 0);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (at + 1 < ids.length) focusRow(ids[at + 1]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at > 0) focusRow(ids[at - 1]);
    }
  }

  updateRows() {
    const by = new Map(this.downloads.items.map((d) => [d.id, d]));
    const fastest = fastestItem(this.downloads.items);
    for (const [id, row] of this.rows) {
      const d = by.get(id);
      if (!d) {
        row.line.textContent = '';
        row.progress.style.display = 'none';
        continue;
      }
      const text = describeDownload(d);
      const tone = toneOf(d);
      row.line.textContent = text ?? '';
      row.line.className = `line ${tone}`;
      if (fastest === id) row.line.append(h('span.fastest', { title: 'Downloading fastest now: would play smoothest' }, 'Fastest'));
      const pct = d.length ? Math.min(100, (d.downloaded / d.length) * 100) : 0;
      row.progress.style.display = d.length ? '' : 'none';
      row.progress.className = `progress ${tone}`;
      row.bar.style.width = `${pct}%`;
      const canPause = d.state !== 'complete' && d.state !== 'watching' && d.state !== 'skipped';
      row.pauseBtn.style.visibility = canPause ? '' : 'hidden';
    }
  }
}

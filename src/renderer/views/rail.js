// SPDX-License-Identifier: MIT OR Apache-2.0
// The navigation rail: back and forward, the views, Settings at the bottom.

import { h, icon, ICONS, replace } from '../lib/dom.js';

const ITEMS = [
  { view: 'browse', label: 'Browse', title: 'What performs best on the swarm (Ctrl+B)', icon: ICONS.browse },
  { view: 'search', label: 'Search', title: 'Search (Ctrl+F)', icon: ICONS.search },
  { view: 'open', label: 'Open', title: 'Open a link or .torrent file (Ctrl+O)', icon: ICONS.open },
  { view: 'library', label: 'Library', title: 'Library and watch progress', icon: ICONS.library },
  { view: 'files', label: 'Files', title: 'Files of the opened torrents', icon: ICONS.files },
  { view: 'player', label: 'Playing', title: 'The video playing', icon: ICONS.player },
];

export class Rail {
  constructor(root, { onNavigate, onBack, onForward }) {
    this.root = root;
    this.onNavigate = onNavigate;
    this.onBack = onBack;
    this.onForward = onForward;
    this.state = { current: 'search', canBack: false, canForward: false, hasTorrent: false, playing: false, upcoming: 0 };
    this.render();
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.render();
  }

  render() {
    // Every button is drawn anew: the one with keyboard or remote focus gets it back after.
    const focused = this.root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    this.draw();
    if (focused) this.root.querySelector(`[data-key="${focused}"]`)?.focus({ preventScroll: true });
  }

  draw() {
    const s = this.state;
    const items = ITEMS.map((it) => {
      const disabled = it.view === 'files' && !s.hasTorrent;
      const wrap = h('span.iconwrap', null, icon(it.icon, { size: 19 }));
      if (it.view === 'player' && s.upcoming > 0) wrap.append(h('span.badge', { 'aria-hidden': 'true' }, s.upcoming > 99 ? '99+' : String(s.upcoming)));
      if (it.view === 'player' && s.playing && s.upcoming === 0) wrap.append(h('span.live', { 'aria-hidden': 'true' }));
      const title = it.view === 'files' ? (s.hasTorrent ? 'Files of the opened torrents' : 'Files (open a torrent first)') : it.view === 'player' ? (s.playing ? 'Back to the video' : 'Nothing is playing') : it.title;
      return h(
        'li',
        null,
        h(
          'button.item',
          {
            type: 'button',
            dataset: { key: it.view },
            class: s.current === it.view ? 'active' : '',
            'aria-current': s.current === it.view ? 'page' : null,
            title,
            disabled,
            onclick: () => this.onNavigate(it.view),
          },
          wrap,
          h('span.label', null, it.label, it.view === 'player' && s.upcoming > 0 ? h('span.sr-only', null, `, ${s.upcoming} up next`) : null),
        ),
      );
    });
    replace(
      this.root,
      h('div.brand', { title: 'Torflix' }, h('img', { src: '../assets/mark.svg', alt: 'Torflix' })),
      h(
        'div.history',
        null,
        h('button.step', { type: 'button', dataset: { key: 'back' }, 'aria-label': 'Back', title: 'Back (Alt+←)', disabled: !s.canBack, onclick: this.onBack }, icon(ICONS.back, { size: 16 })),
        h('button.step', { type: 'button', dataset: { key: 'forward' }, 'aria-label': 'Forward', title: 'Forward (Alt+→)', disabled: !s.canForward, onclick: this.onForward }, icon(ICONS.forward, { size: 16 })),
      ),
      h('ul', null, items),
      h(
        'button.item.settings',
        { type: 'button', dataset: { key: 'settings' }, class: s.current === 'settings' ? 'active' : '', 'aria-current': s.current === 'settings' ? 'page' : null, title: 'Settings (Ctrl+,)', onclick: () => this.onNavigate('settings') },
        h('span.iconwrap', null, icon(ICONS.settings, { size: 19 })),
        h('span.label', null, 'Settings'),
      ),
    );
  }
}

// SPDX-License-Identifier: MIT OR Apache-2.0
// The Library: everything played, with its watch progress; play again from where it stopped.

import { h, replace, icon, ICONS } from '../lib/dom.js';
import { formatBytes, formatTime } from '../../shared/format.js';

function ago(secs) {
  const d = Math.floor((Date.now() / 1000 - secs) / 86400);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
}

export class LibraryView {
  constructor(root, { api, onPlay, onError }) {
    this.root = root;
    this.api = api;
    this.onPlay = onPlay;
    this.onError = onError;
    this.items = [];
    this.render();
  }

  async refresh() {
    try {
      this.items = await this.api.libraryItems();
    } catch (err) {
      this.onError(err);
      return;
    }
    this.renderList();
  }

  render() {
    this.list = h('div');
    replace(
      this.root,
      h(
        'section.page',
        { 'aria-labelledby': 'library-heading' },
        h(
          'div.library-head',
          null,
          h('h2#library-heading', { tabindex: '-1' }, 'Library'),
          h(
            'button.btn.secondary.small',
            {
              type: 'button',
              onclick: async () => {
                if (this.items.length === 0) return;
                await this.api.libraryClear().catch(this.onError);
                this.refresh();
              },
            },
            'Clear history',
          ),
        ),
        h('p.lead', null, `Watch progress is saved on this ${this.api.platform === 'android-tv' ? 'TV' : 'computer'} only. Reopening an unfinished video offers to continue where it stopped.`),
        this.list,
      ),
    );
    this.renderList();
  }

  renderList() {
    if (this.items.length === 0) return replace(this.list, h('p.empty', null, 'Nothing played yet. Videos and tracks you play appear here with their progress.'));
    replace(
      this.list,
      h(
        'ul.library-list',
        null,
        this.items.map((it) => {
          const pct = it.durationSecs ? Math.min(100, (it.positionSecs / it.durationSecs) * 100) : 0;
          const left = it.durationSecs ? Math.max(0, it.durationSecs - it.positionSecs) : null;
          const state = it.completed ? 'Watched' : it.positionSecs > 10 && left !== null ? `${formatTime(left)} left · stopped at ${formatTime(it.positionSecs)}` : it.positionSecs > 10 ? `Stopped at ${formatTime(it.positionSecs)}` : 'Opened';
          const bar = h('div.bar.watched', { style: { width: `${it.completed ? 100 : pct}%` } });
          return h(
            'li.library-item',
            null,
            h('span.title', { title: it.title }, it.title),
            h('span.sub', null, [it.torrentName && it.torrentName !== it.title ? it.torrentName : null, it.sizeBytes ? formatBytes(it.sizeBytes) : null, ago(it.updatedAtSecs)].filter(Boolean).join(' · ')),
            h('span.sub', null, state),
            h('div.progress', null, bar),
            h(
              'div.actions',
              null,
              h('button.btn.primary.small', { type: 'button', title: it.completed ? 'Play it again' : 'Continue', onclick: () => this.onPlay(it) }, icon(ICONS.play, { size: 14, cls: 'fill' }), it.completed ? 'Play again' : 'Continue'),
              h(
                'button.btn.icon-btn',
                {
                  type: 'button',
                  title: 'Remove from the library',
                  'aria-label': 'Remove from the library',
                  onclick: async () => {
                    await this.api.libraryRemove(it.infoHash, it.fileIndex).catch(this.onError);
                    this.refresh();
                  },
                },
                icon(ICONS.trash, { size: 16 }),
              ),
            ),
          );
        }),
      ),
    );
  }
}

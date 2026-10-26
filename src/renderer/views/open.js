// SPDX-License-Identifier: MIT OR Apache-2.0
// The Open page: a magnet link or a link to a .torrent file, a .torrent file from this
// computer, and the torrents opened this session.

import { h, replace } from '../lib/dom.js';
import { formatBytes } from '../../shared/format.js';
import { isTorrentFile, looksLikeLink, mediaNoun, isPlayable } from '../../shared/files.js';

export class OpenView {
  constructor(root, { onLink, onFile, onShow }) {
    this.root = root;
    this.onLink = onLink;
    this.onFile = onFile;
    this.onShow = onShow;
    this.torrents = [];
    this.busy = false;
    this.error = null;
    this.render();
  }

  setTorrents(list) {
    this.torrents = list;
    this.renderList();
  }

  setBusy(busy, error = null) {
    this.busy = busy;
    this.error = error;
    this.renderStatus();
    if (this.submit) this.submit.disabled = busy || this.input.value.trim() === '';
  }

  focus() {
    this.input?.focus();
    this.input?.select();
  }

  render() {
    this.input = h('input', { id: 'open-link', type: 'text', placeholder: 'magnet:?xt=… or https://…/file.torrent', autocomplete: 'off', spellcheck: 'false' });
    this.submit = h('button.btn.primary', { type: 'submit', disabled: true }, 'Open');
    this.input.addEventListener('input', () => {
      this.submit.disabled = this.busy || this.input.value.trim() === '';
    });
    const form = h(
      'form.open-form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const link = this.input.value.trim();
          if (!looksLikeLink(link)) {
            this.setBusy(false, 'Enter a magnet link or an http(s) link to a .torrent file.');
            return;
          }
          this.onLink(link);
          this.input.value = '';
          this.submit.disabled = true;
        },
      },
      h('label.sr-only', { for: 'open-link' }, 'Magnet link or link to a .torrent file'),
      this.input,
      this.submit,
    );
    const fileInput = h('input', {
      type: 'file',
      accept: '.torrent,application/x-bittorrent',
      hidden: true,
      onchange: async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        if (!isTorrentFile(file.name)) return this.setBusy(false, 'That is not a .torrent file.');
        this.onFile(new Uint8Array(await file.arrayBuffer()), file.name);
      },
    });
    this.status = h('p.status-line', { 'aria-live': 'polite' });
    this.list = h('div');
    replace(
      this.root,
      h(
        'section.page.warm',
        { 'aria-labelledby': 'open-heading' },
        h('h2#open-heading', { tabindex: '-1' }, 'Open a torrent'),
        form,
        h(
          'div.open-file.desktop-only',
          null,
          h('button.btn.secondary', { type: 'button', onclick: () => fileInput.click() }, 'Choose a .torrent file…'),
          h('span.hint', null, 'or drop one anywhere on this window'),
          fileInput,
        ),
        this.status,
        this.list,
      ),
    );
    this.renderStatus();
    this.renderList();
  }

  renderStatus() {
    replace(this.status, this.busy ? 'Fetching torrent details…' : this.error ? h('span.error', { role: 'alert' }, this.error) : '');
  }

  renderList() {
    if (this.torrents.length === 0) return replace(this.list);
    replace(
      this.list,
      h('h3', null, 'Opened this session'),
      h(
        'ul.torrent-list',
        null,
        this.torrents.map((t) => {
          const n = t.files.filter(isPlayable).length;
          return h(
            'li',
            null,
            h(
              'button.torrent',
              { type: 'button', onclick: () => this.onShow(t) },
              h('span.name', null, t.name),
              h('span.meta', null, `${formatBytes(t.totalLength)} · ${n} ${mediaNoun(t.files, n)}`),
            ),
          );
        }),
      ),
    );
  }
}

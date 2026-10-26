// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Files view: the torrents opened this session, the chosen torrent's videos in lecture
// order (each with Play), its other files by folder, and a preview of the selected file.

import { h, icon, ICONS, replace } from '../lib/dom.js';
import { formatBytes } from '../../shared/format.js';
import { fileName, folderOf, isPlayable, lectureOrder, mediaNoun, naturalCompare, playableInWebview } from '../../shared/files.js';

export class FilesView {
  constructor(root, { api, onPlay, onError }) {
    this.root = root;
    this.api = api;
    this.onPlay = onPlay;
    this.onError = onError;
    this.torrents = [];
    this.torrentId = null;
    this.selected = null;
    this.details = null;
    this.previewToken = 0;
    this.render();
  }

  setTorrents(list) {
    this.torrents = list;
    if (this.torrentId !== null && !list.some((t) => t.id === this.torrentId)) this.torrentId = null;
    if (this.torrentId === null && list.length > 0) this.torrentId = list[0].id;
    this.renderAll();
  }

  get torrent() {
    return this.torrents.find((t) => t.id === this.torrentId) ?? null;
  }

  show(torrentId) {
    if (torrentId !== null && torrentId !== undefined) {
      this.torrentId = torrentId;
      this.selected = null;
      this.details = null;
    }
    this.renderAll();
    const t = this.torrent;
    if (t) {
      this.api.torrentDetails(t.id).then(
        (d) => {
          if (this.torrentId !== t.id) return;
          this.details = d;
          this.renderPreview();
        },
        () => {},
      );
    }
  }

  render() {
    this.left = h('aside.files-torrents', { 'aria-label': 'Torrents' });
    this.main = h('section.files-main', { 'aria-label': 'Files' });
    this.preview = h('aside.files-preview', { 'aria-label': 'Preview' });
    replace(this.root, h('div.files-layout', null, this.left, this.main, this.preview));
  }

  renderAll() {
    this.renderLeft();
    this.renderMain();
    this.renderPreview();
  }

  renderLeft() {
    replace(
      this.left,
      h('h3', null, 'Torrents'),
      this.torrents.length === 0
        ? h('p.empty', { style: { padding: '0 0.4rem', fontSize: '0.85rem' } }, 'Nothing opened yet.')
        : h(
            'ul',
            null,
            this.torrents.map((t) => {
              const n = t.files.filter(isPlayable).length;
              return h(
                'li',
                null,
                h(
                  'button',
                  { type: 'button', class: t.id === this.torrentId ? 'active' : '', onclick: () => this.show(t.id) },
                  h('span.name', null, t.name),
                  h('span.meta', null, `${formatBytes(t.totalLength)} · ${n} ${mediaNoun(t.files, n)}`),
                ),
              );
            }),
          ),
    );
  }

  renderMain() {
    const t = this.torrent;
    if (!t) return replace(this.main, h('p.empty', null, 'Open a torrent, or add one from a search, to see its files here.'));
    const media = lectureOrder(t.files);
    const others = t.files.filter((f) => !isPlayable(f)).sort((a, b) => naturalCompare(a.path, b.path));
    const folders = new Map();
    for (const f of others) {
      const folder = folderOf(f.path);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(f);
    }
    const row = (f, playable) => {
      return h(
        'li.file-row',
        {
          class: this.selected === f.index ? 'selected' : '',
          tabindex: '0',
          onclick: () => this.select(f.index),
          ondblclick: () => playable && this.onPlay({ torrent: t, file: f }),
          onkeydown: (e) => {
            if (e.key === 'Enter' && playable) this.onPlay({ torrent: t, file: f });
          },
        },
        h('span.kind', null, icon(f.kind === 'audio' ? ICONS.music : f.kind === 'video' ? ICONS.film : ICONS.files, { size: 15 })),
        h('span.name', { title: f.path }, fileName(f.path), playable && !playableInWebview(f.path) ? h('span.dim', null, ' · needs a full player') : null),
        h('span.size', null, formatBytes(f.length)),
        playable
          ? h(
              'span.actions',
              null,
              h('button.btn.primary.small', { type: 'button', onclick: (e) => (e.stopPropagation(), this.onPlay({ torrent: t, file: f })) }, 'Play'),
            )
          : h('span'),
      );
    };
    replace(
      this.main,
      h(
        'div.head',
        null,
        h('h2', { title: t.name }, t.name),
        h(
          'div',
          { style: { display: 'flex', gap: '0.4rem', flex: 'none' } },
          media.length > 0 ? h('button.btn.primary.small', { type: 'button', onclick: () => this.onPlay({ torrent: t, file: null }) }, icon(ICONS.play, { size: 13, cls: 'fill' }), 'Play') : null,
        ),
      ),
      h('h3', null, media.length === 0 ? 'No videos or tracks' : `${media.length} ${mediaNoun(t.files, media.length)}`),
      media.length > 0 ? h('ul.file-rows', null, media.map((f) => row(f, true))) : null,
      others.length > 0 ? h('h3', null, `${others.length} other ${others.length === 1 ? 'file' : 'files'}`) : null,
      [...folders.entries()].map(([folder, files]) => [folder ? h('p.folder-head', null, folder) : null, h('ul.file-rows', null, files.map((f) => row(f, false)))]),
    );
  }

  select(index) {
    this.selected = index;
    this.renderMain();
    this.renderPreview();
  }

  async renderPreview() {
    const t = this.torrent;
    if (!t) return replace(this.preview);
    const file = this.selected === null ? null : t.files.find((f) => f.index === this.selected);
    const d = this.details;
    const info = h(
      'dl.kv',
      null,
      h('dt', null, 'Files'),
      h('dd', null, String(t.files.length)),
      h('dt', null, 'Size'),
      h('dd', null, formatBytes(t.totalLength)),
      h('dt', null, 'Info hash'),
      h('dd', null, h('code', { style: { fontSize: '0.75rem' } }, t.infoHash)),
      d ? [h('dt', null, 'Pieces'), h('dd', null, formatBytes(d.pieceLength)), h('dt', null, 'Trackers'), h('dd', null, `${d.udpTrackers} UDP · ${d.httpTrackers} HTTP · ${d.webSeeds} web seeds`)] : null,
      d?.createdBy ? [h('dt', null, 'Created by'), h('dd', null, d.createdBy)] : null,
      d?.createdMs ? [h('dt', null, 'Created'), h('dd', null, new Date(d.createdMs).toLocaleDateString())] : null,
      d?.comment ? [h('dt', null, 'Comment'), h('dd', null, d.comment)] : null,
    );
    if (!file) return replace(this.preview, h('h3', null, 'About this torrent'), info);
    const body = h('div', null, h('p.note', null, 'Loading preview…'));
    replace(this.preview, h('h3', null, fileName(file.path)), h('p.note', null, `${formatBytes(file.length)} · ${file.kind}`), body, h('h3', { style: { marginTop: '1.25rem' } }, 'About this torrent'), info);
    const token = ++this.previewToken;
    try {
      const p = await this.api.previewFile(t.id, file.index);
      if (token !== this.previewToken) return;
      if (p.kind === 'image') replace(body, h('img', { src: p.image, alt: '' }));
      else if (p.kind === 'text') replace(body, h('pre', null, p.text), p.truncated ? h('p.note', null, 'Cut at 64 KiB.') : null);
      else replace(body, h('p.note', null, p.note ?? 'No preview.'));
    } catch (err) {
      if (token === this.previewToken) replace(body, h('p.note', null, err.message));
    }
  }
}

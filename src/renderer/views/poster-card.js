// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The pieces Browse and title pages share: a title's poster card, and one torrent of a title
// as a line with Play.

import { h, replace } from '../lib/dom.js';
import { formatBytes } from '../../shared/format.js';

/** A title's poster card; a click, Enter or the remote's OK opens it. */
export function posterCard(t, { onOpen }) {
  const card = h(
    'li.poster-card',
    {
      tabindex: '0',
      role: 'button',
      dataset: { key: t.key },
      'aria-label': `${t.title}${t.year ? ` (${t.year})` : ''}`,
      onclick: () => onOpen(t),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(t);
        }
      },
    },
    h('div.poster'),
    h('div.card-caption', null, h('span.card-title', null, t.title), h('span.card-sub')),
  );
  fillCard(card, t);
  return card;
}

/** Fills (or refills, as information arrives) a card's poster and caption. */
export function fillCard(card, t) {
  const poster = card.querySelector('.poster');
  const sub = card.querySelector('.card-sub');
  const title = card.querySelector('.card-title');
  title.textContent = t.meta?.title ?? t.title;
  if (t.meta?.poster) {
    replace(poster, h('img', { src: t.meta.poster, alt: '', loading: 'lazy', decoding: 'async' }));
    poster.classList.remove('text');
  } else {
    replace(poster, h('span.poster-text', null, t.title), h('span.poster-year', null, t.year ? String(t.year) : ''));
    poster.classList.add('text');
    poster.style.setProperty('--hue', String(hueOf(t.key ?? t.title)));
  }
  const bits = [];
  if (t.year) bits.push(String(t.year));
  if (t.seeders !== null && t.seeders !== undefined) bits.push(`${t.seeders} seeders`);
  else if (t.scheduled?.airtime) bits.push(`${t.scheduled.airtime}${t.meta?.network ? ` · ${t.meta.network}` : ''}`);
  if (t.best?.quality?.label) bits.push(t.best.quality.label.split(' ')[0]);
  if (t.meta?.rating) bits.push(`★ ${t.meta.rating.toFixed(1)}`);
  sub.textContent = bits.join(' · ');
  const badge = card.querySelector('.card-badge');
  if (badge) badge.remove();
  if (t.scheduled) card.append(h('span.card-badge.soft', null, t.scheduled.number ? `S${t.scheduled.season} E${t.scheduled.number}` : 'Today'));
}

/** A card's place in a top-ten row, shown large on its poster. */
export function rankCard(card, rank) {
  card.querySelector('.poster').dataset.rank = String(rank);
  card.setAttribute('aria-label', `${rank}. ${card.getAttribute('aria-label')}`);
}

/** A colour for a title with no poster, the same every time. */
export function hueOf(text) {
  let n = 0;
  for (const ch of String(text)) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}

/** One torrent of a title: its name, seeders, size and quality, with Play. */
export function torrentLine(tor, { onPlay }) {
  return h(
    'li.torrent-line',
    { dataset: { key: tor.key ?? tor.infoHash ?? tor.link } },
    h(
      'div.text',
      null,
      h('span.title', { title: tor.title }, tor.title),
      h('span.meta', null, [tor.seeders !== null && tor.seeders !== undefined ? `${tor.seeders} seeders` : 'seeders unknown', tor.sizeBytes ? formatBytes(tor.sizeBytes) : null, tor.quality?.label || null, tor.quality?.codec, tor.indexers?.join(', ')].filter(Boolean).join(' · ')),
    ),
    h(
      'div.actions',
      null,
      h('button.btn.primary.small', { type: 'button', onclick: () => onPlay(tor) }, 'Play'),
    ),
  );
}

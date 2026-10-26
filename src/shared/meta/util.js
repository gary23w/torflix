// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Small helpers the title-information modules share. These modules run in the app (main
// process, Android backend) and in the Torflix metadata service (meta/), so they import nothing
// outside src/shared.

import { titleKey } from '../release.js';

export const str = (v, max = 4000) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const yearOf = (date) => (typeof date === 'string' && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text cut at a word near `max` characters, with an ellipsis when cut. */
export function clip(text, max) {
  const s = str(text, 100_000);
  if (!s || s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

/** An image address without the tracking query some sources append. */
export function cleanImage(url) {
  const s = str(url, 1000);
  return s && /^https:\/\//.test(s) ? s.replace(/\?.*$/, '') : null;
}

/**
 * The title as it appears in a metadata service address: lower case, accents dropped, "&" read
 * as "and", every other run of punctuation or space a single "-" ("Dune: Part Two" →
 * "dune-part-two"). Every spelling of a title gives the same address, so one cached answer
 * serves them all.
 */
export function titleSlug(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '');
}

/** The words of a slug, for searching. */
export const slugWords = (slug) => String(slug ?? '').split('-').filter(Boolean).join(' ');

/** Whether two titles are the same title, ignoring punctuation, case and a leading article. */
export function sameName(a, b) {
  const k = (t) => titleKey(t);
  const bare = (t) => k(String(t ?? '').replace(/^\s*(the|a|an)\s+/i, ''));
  return k(a) === k(b) || bare(a) === bare(b);
}

/** A failure that may pass (network, timeout, rate limit, server error): never cached. */
export class MetaError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** The User-Agent Torflix sends to every metadata source: who it is, and where to reach the project. */
export function userAgent(version, platform = null) {
  return `Torflix/${version || '0'} (https://github.com/gary23w/torflix${platform ? `; ${platform}` : ''})`;
}

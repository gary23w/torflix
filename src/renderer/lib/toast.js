// SPDX-License-Identifier: MIT OR Apache-2.0
// Toasts at the bottom of the window, with an optional action (Undo).

import { h } from './dom.js';

const DEFAULT_MS = 5000;

export function toast(message, { action = null, onAction = null, ms = DEFAULT_MS, kind = 'info' } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div.toast', { class: kind, role: kind === 'error' ? 'alert' : 'status' }, h('span.toast-text', null, message));
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action && onAction) {
    el.append(
      h('button.toast-action', {
        type: 'button',
        onclick: () => {
          dismiss();
          onAction();
        },
      }, action),
    );
  }
  el.append(h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, '×'));
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  timer = setTimeout(dismiss, ms);
  return dismiss;
}

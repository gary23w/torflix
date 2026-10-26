// SPDX-License-Identifier: MIT OR Apache-2.0
// Tiny DOM helpers. Everything is built with `h()` and text nodes, so torrent names and other
// data are never parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `h('button.primary#go', { onclick, title }, 'Go')`. Children may be strings, nodes, arrays,
 * or null. Props: `class`/`className`, `dataset`, `style` (object), `aria*`, event handlers
 * (`onclick`), and attributes.
 */
export function h(tag, props = null, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const r of rest) {
    if (r.startsWith('.')) el.classList.add(r.slice(1));
    else if (r.startsWith('#')) el.id = r.slice(1);
  }
  if (props) setProps(el, props);
  append(el, children);
  return el;
}

export function setProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      for (const c of String(value).split(/\s+/)) if (c) el.classList.add(c);
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'muted' || key === 'open') el[key] = value;
    else if (key === 'text') el.textContent = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replaces an element's children. */
export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

/** An inline SVG icon from a 24×24 path (stroke icons, like the upstream rail). */
export function icon(path, { size = 20, cls = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('icon');
  if (cls) svg.classList.add(cls);
  for (const d of Array.isArray(path) ? path : [path]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  browse: 'M4 5.5h6.5v5.5H4zM13.5 5.5H20v5.5h-6.5zM4 13h6.5v5.5H4zM13.5 13H20v5.5h-6.5z',
  search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l5 5',
  open: 'M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z',
  library: 'M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12H7a2 2 0 0 1-2-2V4.5ZM7 19a2 2 0 0 1 2-2h10M9 8h6M9 11.5h5',
  files: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  player: 'M4.5 5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM10 9v6l5-3z',
  settings:
    'M18.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L14 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  back: 'M14.5 6l-6 6 6 6',
  forward: 'M9.5 6l6 6-6 6',
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  next: 'M6 5v14l9-7zM17 5h2v14h-2z',
  prev: 'M18 5v14l-9-7zM5 5h2v14H5z',
  volume: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  muted: 'M4 9v6h4l5 4V5L8 9zM16 9l5 6M21 9l-5 6',
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  exitFullscreen: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5',
  cc: ['M3 5.5h18v13H3z', 'M10.6 10.3a2.1 2.1 0 1 0 0 3.4M16.6 10.3a2.1 2.1 0 1 0 0 3.4'],
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronLeft: 'M14.5 6l-6 6 6 6',
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5',
  folder: 'M3.5 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1h-8l-2-2.5h-5a1 1 0 0 0-1 1z',
  film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  external: 'M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  debug: 'M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2',
};

/** Debounces a function. */
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Closes a popup menu when the pointer or focus goes elsewhere. */
export function closeOnOutside(menu, onClose) {
  const down = (e) => {
    if (!menu.contains(e.target)) {
      cleanup();
      onClose();
    }
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      cleanup();
      onClose();
    }
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('keydown', key, true);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
  }, 0);
  return cleanup;
}

/** A unique id for queue items and the like. */
export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

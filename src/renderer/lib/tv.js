// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Android TV: the same pages, driven by a remote. The arrow keys move focus to the nearest
// control in that direction (back into a row or a set of buttons where the viewer left it),
// and the page scrolls as a TV app's does (see `reveal`); OK presses the focused control as
// Enter does, and the remote's Back key (sent by the app as a `tv-back` event) closes what is
// open, then goes back a page, then leaves the app. Open menus hold focus while they are open.
// Nothing here runs on the desktop.

import { toast } from './toast.js';

const DIRECTIONS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
/** A second Back on the first page within this long leaves the app. */
const LEAVE_WINDOW_MS = 2500;
// Also `[role="button"]` kept out of the tab order on the desktop (a search result's text, which
// its Details button repeats): on a TV it is the natural stop when moving down a list.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"]';
/** Misalignment counts this much more than distance, so the control straight ahead wins. */
const OFF_AXIS_WEIGHT = 2;
/** A control that does not line up with the focused one at all must be this much nearer. */
const NOT_ALIGNED_PENALTY = 60;
/** Groups focus comes back into where it left them: rows of cards, sets of buttons. */
const GROUPS = '.poster-row, .hero-actions, .title-actions, .season-tabs';

export const isTv = (api) => api?.platform === 'android-tv';

/** How far two controls may overlap and still be one beyond the other (a focused card grows). */
const OVERLAP_SLACK = 0.25;

/**
 * The candidate to move to from `from` in direction `dir`, or null. Rectangles are
 * `{ left, top, right, bottom }` in the same coordinates; candidates are `{ rect, item }`.
 * A candidate counts if it lies beyond the focused control in that direction (overlapping it by
 * at most a quarter of the smaller of the two). Among those, the nearest wins, where distance
 * along the direction is the gap between the edges and distance across it is the offset of the
 * centres, weighted; one that overlaps the focused control across the direction (the same row
 * or column) is preferred.
 */
export function pickNext(from, candidates, dir) {
  const fx = (from.left + from.right) / 2;
  const fy = (from.top + from.bottom) / 2;
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const r = c.rect;
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    let gap;
    let across;
    let overlap;
    if (dir === 'right' || dir === 'left') {
      const slack = Math.min(from.right - from.left, r.right - r.left) * OVERLAP_SLACK;
      gap = dir === 'right' ? r.left - from.right : from.left - r.right;
      if (gap < -slack) continue;
      across = Math.abs(cy - fy);
      overlap = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
    } else {
      const slack = Math.min(from.bottom - from.top, r.bottom - r.top) * OVERLAP_SLACK;
      gap = dir === 'down' ? r.top - from.bottom : from.top - r.bottom;
      if (gap < -slack) continue;
      across = Math.abs(cx - fx);
      overlap = Math.min(from.right, r.right) - Math.max(from.left, r.left);
    }
    gap = Math.max(0, gap);
    const score = gap + across * OFF_AXIS_WEIGHT + (overlap > 0 ? 0 : NOT_ALIGNED_PENALTY);
    if (score < bestScore) {
      bestScore = score;
      best = c.item;
    }
  }
  return best;
}

/**
 * Starts remote control. `nav` is the app's history; `exit` leaves the app (Back on the first
 * page). Returns `ensureFocus()`, for the app to call once its first page is shown.
 */
export function startTv({ api, nav, exit }) {
  document.documentElement.classList.add('tv');
  document.body.classList.add('tv');
  /** The last control focused anywhere, to find its stand-in when a redraw replaces it. */
  let last = null;
  /** When Back was last pressed on the first page (a second press soon after leaves). */
  let backAtRoot = 0;
  /** The control last focused on each page outside its menus and panels, to come back to it. */
  const lastOnPage = new Map();
  /** The control last focused in each row of cards or set of buttons (see `entryPoint`). */
  const groupMemory = new WeakMap();

  window.addEventListener(
    'keydown',
    (e) => {
      // OK or an arrow just after a redraw took the control away: focus comes back, and OK
      // presses the control the viewer was on.
      if ((e.key === 'Enter' || DIRECTIONS[e.key]) && lost()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!recover()) return ensureFocus();
        if (e.key === 'Enter') document.activeElement.click();
        return;
      }
      // OK on a role="button" that only answers clicks (it is out of the desktop's tab order).
      const target = document.activeElement;
      if (e.key === 'Enter' && target instanceof HTMLElement && target.matches('[role="button"][tabindex="-1"]')) {
        e.preventDefault();
        target.click();
        return;
      }
      const dir = DIRECTIONS[e.key];
      if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (keepsArrow(document.activeElement, dir)) return;
      // Ahead of every other handler: on a TV the arrows only move focus (the player's own
      // arrow shortcuts would otherwise seek or change the volume).
      e.preventDefault();
      e.stopImmediatePropagation();
      move(dir);
    },
    true,
  );

  document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    last = { el: e.target, sig: signature(e.target), rect: e.target.getBoundingClientRect() };
    const group = e.target.closest(GROUPS);
    if (group) groupMemory.set(group, e.target);
    if (overlay()?.contains(e.target)) return;
    const page = pageKey(e.target.closest('.view'));
    if (page) lastOnPage.set(page, e.target);
  });

  /** Which page a view shows: its name, and for a title page which title (each is its own). */
  function pageKey(view) {
    const name = view?.dataset.view;
    return name === 'title' ? `title:${nav.current?.key ?? ''}` : name;
  }

  // Views redraw as data arrives (the hero and title pages when their information comes,
  // search rows as results stream in), and a redraw that replaces the focused control leaves
  // the remote on nothing. Older WebViews announce that with a focusout; newer ones are caught
  // at the next key press.
  document.addEventListener('focusout', (e) => {
    if (!e.relatedTarget) setTimeout(recover, 0);
  });

  // While a text field has focus, the TV's on-screen keyboard stays up and takes the remote's
  // keys (OK would send the search again). Once a form is sent, focus moves to its button,
  // which closes the keyboard and leaves the remote on the page.
  document.addEventListener(
    'submit',
    (e) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement) || !(e.target instanceof HTMLFormElement) || !e.target.contains(active)) return;
      const button = e.target.querySelector('button[type="submit"], button:not([type="button"])');
      if (button) focus(button);
      else active.blur();
    },
    true,
  );

  api.on('tv-back', () => back());
  nav.on('change', () => setTimeout(ensureFocus, 0));

  function move(dir) {
    const scope = overlay() ?? document.body;
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || current === document.body || !scope.contains(current) || !shown(current)) return ensureFocus();
    // Up and down stay on the page or in the rail; only left and right cross between them.
    const rail = document.getElementById('rail');
    const inRail = rail?.contains(current);
    // Along a row of cards, left and right stay in it: at its end, nothing happens (left from
    // its first card still reaches the rail).
    const row = dir === 'left' || dir === 'right' ? current.closest('.poster-row') : null;
    const along = row ? focusables(row).filter((el) => el !== current) : null;
    const pool = along && (dir === 'right' || along.some((el) => el.getBoundingClientRect().right <= current.getBoundingClientRect().left + 1)) ? along : focusables(scope);
    const candidates = pool
      .filter((el) => el !== current && (dir === 'left' || dir === 'right' || rail?.contains(el) === inRail))
      .map((el) => ({ rect: el.getBoundingClientRect(), item: el }));
    const next = pickNext(current.getBoundingClientRect(), candidates, dir);
    if (!next) {
      // Up with nothing above: the top of the page (the hero, a title's poster) comes into view.
      const view = current.closest('.view');
      if (dir === 'up' && !inRail && view) glide(view, 'scrollTop', 0);
      return;
    }
    // Into the rail from a page: onto the page's own item, wherever the page was.
    if (rail && !inRail && rail.contains(next)) {
      const here = rail.querySelector('.item.active');
      return focus(here && shown(here) ? here : next);
    }
    focus(dir === 'up' || dir === 'down' ? entryPoint(next, current) : next);
  }

  /**
   * Moving up or down into another group (a row of cards, a set of buttons): back to where the
   * viewer was in it, else to its start (a row's first card on screen, a page's main button),
   * not merely the control that happens to lie nearest above or below.
   */
  function entryPoint(next, from) {
    const group = next.closest(GROUPS);
    if (!group || group === from.closest(GROUPS)) return next;
    // A page's main buttons: back onto Play, as a streaming app's billboard does.
    const main = group.querySelector('[data-autofocus]');
    if (main && shown(main)) return main;
    const kept = groupMemory.get(group);
    if (kept?.isConnected && group.contains(kept) && shown(kept)) return kept;
    if (group.matches('.poster-row')) {
      const edge = group.getBoundingClientRect().left + (parseFloat(getComputedStyle(group).paddingLeft) || 0) - 4;
      return focusables(group).find((el) => el.getBoundingClientRect().left >= edge) ?? next;
    }
    return focusables(group)[0] ?? next;
  }

  function back() {
    const open = openState();
    if (open) {
      // Menus and the Up next card close on Escape.
      const scope = overlay();
      const target = scope?.contains(document.activeElement) ? document.activeElement : (scope ?? document.body);
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (openState() !== open) {
        // Back to the control the menu or panel was opened from.
        setTimeout(ensureFocus, 0);
        return;
      }
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) active.blur();
    if (nav.canBack) return nav.back();
    // Leaving stops the engine and whatever it was streaming: one Back too many must not do it.
    if (Date.now() - backAtRoot < LEAVE_WINDOW_MS) return exit();
    backAtRoot = Date.now();
    toast('Press Back again to leave Torflix.', { ms: LEAVE_WINDOW_MS });
  }

  /** Whether focus is on nothing the viewer can see. */
  function lost() {
    const a = document.activeElement;
    return !(a instanceof HTMLElement) || a === document.body || !a.isConnected || !shown(a);
  }

  /**
   * Puts focus back after a redraw took it: on the same control if the redraw only moved it,
   * else on the control that replaced it (the same kind, with the same label, nearest where the
   * old one was). A text field that was blurred on purpose is left alone.
   */
  function recover() {
    if (!lost() || !last) return false;
    if (last.el.isConnected) {
      if (!shown(last.el) || last.el.matches('input, textarea, select')) return false;
      focus(last.el);
      return true;
    }
    const scope = overlay() ?? document.querySelector('.view.active') ?? document.body;
    const near = (el) => {
      const r = el.getBoundingClientRect();
      return Math.hypot(r.left - last.rect.left, r.top - last.rect.top);
    };
    const standIn = [...focusables(scope), ...focusables(document.getElementById('rail') ?? scope)]
      .filter((el) => signature(el) === last.sig)
      .sort((a, b) => near(a) - near(b))[0];
    if (!standIn) return false;
    focus(standIn);
    return true;
  }

  /**
   * Puts focus somewhere visible when it is on nothing, or on a page that was just hidden: back
   * on the control last used on that page if it is still there (or the one that replaced it: a
   * Browse card redrawn with fresh rows), else the page's own first choice (`data-autofocus`, a
   * title page's Play), else its first control.
   */
  function ensureFocus() {
    const current = document.activeElement;
    const scope = overlay();
    if (current instanceof HTMLElement && current !== document.body && shown(current) && (!scope || scope.contains(current))) return;
    const view = document.querySelector('.view.active');
    const before = view && !scope ? lastOnPage.get(pageKey(view)) : null;
    if (before?.isConnected && view.contains(before) && shown(before)) return focus(before);
    const key = before?.dataset.key;
    if (view && !scope && key) {
      const row = before.closest('[data-row]')?.dataset.row;
      const same = (row ? view.querySelector(`[data-row="${CSS.escape(row)}"] [data-key="${CSS.escape(key)}"]`) : null) ?? view.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (same && shown(same)) return focus(same);
    }
    const auto = !scope ? view?.querySelector('[data-autofocus]') : null;
    if (auto && shown(auto)) return focus(auto);
    focusFirst(scope ?? view ?? document.body);
  }

  /**
   * The top-left control of a page or panel (the rail's, if the page has none). A text field
   * comes last: focusing one brings up the on-screen keyboard over everything.
   */
  function focusFirst(scope) {
    const typing = (el) => (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea') ? 1 : 0);
    const first = focusables(scope).sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return typing(a) - typing(b) || ra.top - rb.top || ra.left - rb.left;
    })[0];
    if (first) focus(first);
    else if (scope !== document.body) focusFirst(document.body);
  }

  return { ensureFocus };
}

function focus(el) {
  el.focus({ preventScroll: true });
  reveal(el);
}

/** Where a row of cards sits once one of its cards is focused: its heading this far down the screen. */
const ROW_AT = 0.07;
/** A control this near the top of its page shows the page from its top (the hero, a title's buttons). */
const TOP_ZONE = 0.8;

/**
 * Brings the focused control into view the way a TV app does, never just "nearest" (which
 * left the hero's text above the screen, and a card's frame half off it):
 *   - a card in a row: the row comes to the same height every time, and slides so the card is
 *     at its start, the ones before it gone off to the left;
 *   - a control near the top of its page: the page from its very top;
 *   - anything else: in the middle of the screen.
 */
function reveal(el) {
  const view = el.closest('.view');
  if (!view) return el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const height = view.clientHeight;
  const row = el.closest('.poster-row');
  if (row) {
    const pad = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    glide(row, 'scrollLeft', row.scrollLeft + (el.getBoundingClientRect().left - row.getBoundingClientRect().left) - pad);
    const section = row.closest('.browse-row, .title-section') ?? row;
    // The first row stays under the hero, as it opened.
    const top = topWithin(section, view);
    return glide(view, 'scrollTop', top + section.offsetHeight < height * TOP_ZONE ? 0 : top - height * ROW_AT);
  }
  const top = topWithin(el, view);
  if (top + el.offsetHeight < height * TOP_ZONE) return glide(view, 'scrollTop', 0);
  return glide(view, 'scrollTop', top - (height - el.offsetHeight) / 2);
}

function topWithin(el, scroller) {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** How long a scroll takes: quick, so the page keeps up with a held arrow key. */
const GLIDE_MS = 140;
const glides = new WeakMap();

/**
 * Scrolls `el` (`scrollTop` or `scrollLeft`) to `target` in a short, eased glide. A new glide
 * starts from wherever the last one had got to, so a held key never queues scrolling up.
 */
function glide(el, prop, target) {
  const max = prop === 'scrollTop' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const to = Math.round(Math.max(0, Math.min(target, max)));
  const from = el[prop];
  const running = glides.get(el);
  if (running) cancelAnimationFrame(running[prop] ?? 0);
  if (Math.abs(to - from) <= 1) return;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / GLIDE_MS);
    el[prop] = from + (to - from) * (1 - (1 - t) ** 3);
    if (t < 1) glides.set(el, { ...glides.get(el), [prop]: requestAnimationFrame(step) });
  };
  glides.set(el, { ...running, [prop]: requestAnimationFrame(step) });
}

/** What makes a redrawn control the same one: its kind, its label, and its rail key if any. */
function signature(el) {
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${el.tagName}|${label}|${el.closest('[data-key]')?.dataset.key ?? ''}`;
}

/** An open menu or the Up next card: focus stays inside while it is open. */
function overlay() {
  const popup = document.querySelector('.menu .popup');
  if (popup) return popup.closest('.menu');
  const upNext = document.querySelector('.view.active .upnext:not([hidden])');
  return upNext ?? null;
}

/** What is open, as a string that changes when something closes; '' when nothing is. */
function openState() {
  const popups = document.querySelectorAll('.menu .popup').length;
  const upNext = document.querySelector('.view.active .upnext:not([hidden])') ? 1 : 0;
  return popups + upNext === 0 ? '' : `${popups}/${upNext}`;
}

function focusables(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(shown);
}

function shown(el) {
  if (el.getClientRects().length === 0 || el.closest('[hidden], [inert]')) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** Arrows a control needs for itself: moving the caret in text, or a slider's value. */
function keepsArrow(el, dir) {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement && el.type === 'range') return dir === 'left' || dir === 'right';
  const text = (el instanceof HTMLInputElement && /^(text|search|url|password)$/.test(el.type)) || el instanceof HTMLTextAreaElement;
  if (!text || (dir !== 'left' && dir !== 'right')) return false;
  // At either end of the text, the arrow leaves the field.
  const at = el.selectionStart ?? 0;
  return dir === 'left' ? at > 0 : at < el.value.length;
}

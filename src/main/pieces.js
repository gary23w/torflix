// SPDX-License-Identifier: MIT OR Apache-2.0
// Piece arithmetic over a WebTorrent file: what is verified around the playhead, whether a
// file can start at once, and the piece map the seek bar and debug overlay draw.

/** Cells in a piece map. */
export const PIECE_MAP_CELLS = 200;
/** Bytes at the start of a file that must be present before playing it starts at once. */
export const HEAD_BYTES = 2 * 1024 * 1024;
/** Bytes at the end (MP4 index, Matroska cues) that must be present too. */
export const TAIL_BYTES = 1024 * 1024;

/** The torrent pieces a byte range of a file covers, inclusive. */
export function pieceRange(file, start, end) {
  const torrent = file._torrent;
  const first = Math.floor((file.offset + start) / torrent.pieceLength);
  const last = Math.floor((file.offset + end) / torrent.pieceLength);
  return [first, Math.min(last, torrent.pieces.length - 1)];
}

/** Whether every piece of a byte range is verified. */
export function rangeVerified(file, start, end) {
  const torrent = file._torrent;
  if (!torrent?.bitfield || file.length === 0) return false;
  const [a, b] = pieceRange(file, Math.max(0, start), Math.min(file.length - 1, end));
  for (let i = a; i <= b; i++) if (!torrent.bitfield.get(i)) return false;
  return true;
}

/** Contiguous verified bytes from `position` onward (a lower bound, piece-aligned). */
export function bufferedAfter(file, position) {
  const torrent = file._torrent;
  if (!torrent?.bitfield || file.length === 0) return 0;
  const pos = Math.min(Math.max(0, position), file.length - 1);
  const [first, last] = pieceRange(file, pos, file.length - 1);
  let piece = first;
  while (piece <= last && torrent.bitfield.get(piece)) piece++;
  if (piece === first) return 0;
  // Bytes from the playhead to the end of the last contiguous verified piece.
  const endByte = Math.min(file.length, piece * torrent.pieceLength - file.offset);
  return Math.max(0, endByte - pos);
}

/** Verified bytes of the file (same as `file.downloaded`, but tolerant of a missing torrent). */
export function downloadedOf(file) {
  try {
    return file.downloaded;
  } catch {
    return 0;
  }
}

export function isComplete(file) {
  return file.length > 0 && downloadedOf(file) >= file.length;
}

/** The start and the end of the file are verified, so playing it starts at once. */
export function startable(file) {
  if (file.length === 0) return false;
  if (isComplete(file)) return true;
  const head = Math.min(file.length - 1, Math.max(HEAD_BYTES, Math.floor(file.length * 0.02)));
  const tailStart = Math.max(0, file.length - TAIL_BYTES);
  return rangeVerified(file, 0, head) && rangeVerified(file, tailStart, file.length - 1);
}

/** A piece map: `cells` values, each 0 (nothing) to 255 (every piece of that span verified). */
export function pieceMap(file, cells = PIECE_MAP_CELLS) {
  const torrent = file._torrent;
  const out = new Array(cells).fill(0);
  if (!torrent?.bitfield || file.length === 0) return out;
  const [first, last] = pieceRange(file, 0, file.length - 1);
  const count = last - first + 1;
  if (count <= 0) return out;
  if (count <= cells) {
    for (let c = 0; c < cells; c++) {
      const piece = first + Math.floor((c * count) / cells);
      out[c] = torrent.bitfield.get(piece) ? 255 : 0;
    }
    return out;
  }
  for (let c = 0; c < cells; c++) {
    const a = first + Math.floor((c * count) / cells);
    const b = first + Math.floor(((c + 1) * count) / cells) - 1;
    let have = 0;
    for (let i = a; i <= b; i++) if (torrent.bitfield.get(i)) have++;
    out[c] = Math.round((255 * have) / (b - a + 1));
  }
  return out;
}

/** Priority of the pieces right at the playhead: above every other selection. */
export const FOCUS_PRIORITY = 3;
/** Bytes ahead of the playhead fetched at that priority (at least two pieces). */
const FOCUS_BYTES = 24 * 1024 * 1024;

/** How many pieces a focus covers for this torrent's piece size. */
export function focusPieces(torrent) {
  const len = torrent?.pieceLength || FOCUS_BYTES;
  return Math.min(48, Math.max(2, Math.ceil(FOCUS_BYTES / len)));
}

/**
 * Fetches a run of pieces ahead of everything else, and lets peers hand slow peers' blocks of
 * them to faster ones. A focus is a stream-style selection in WebTorrent 3's selection list (as
 * its own file streams make): unlike `torrent.select()` it is never merged with the torrent's
 * other selections, which would lift a whole file to its priority, and it is removed exactly.
 * WebTorrent serves equal priorities in turn, so the playhead must be above the rest of the
 * file, or a seek waits while bandwidth goes to pieces nobody asked for. Returns null when
 * every piece of the run is already there. `critical: false` leaves slow peers their blocks of
 * it (for a run wanted soon, not waited on).
 */
export function addFocus(torrent, from, to, priority = FOCUS_PRIORITY, { critical = true } = {}) {
  if (!torrent || torrent.destroyed || !torrent.ready || !torrent._selections || !torrent.bitfield) return null;
  const last = torrent.pieces.length - 1;
  const a = Math.max(0, Math.min(from, last));
  const b = Math.max(a, Math.min(to, last));
  let missing = false;
  for (let i = a; i <= b && !missing; i++) missing = !torrent.bitfield.get(i);
  if (!missing) return null;
  const item = { from: a, to: b, offset: 0, priority, notify: null, isStreamSelection: true };
  try {
    torrent._selections.insert(item);
    torrent._selections.sort((x, y) => y.priority - x.priority);
    if (critical) torrent.critical(a, b);
  } catch {
    return null;
  }
  return item;
}

/** Drops a focus (a no-op once WebTorrent dropped it itself, all its pieces being there). */
export function removeFocus(torrent, item) {
  if (!item || !torrent || torrent.destroyed || !torrent._selections) return;
  const items = torrent._selections._items;
  const i = Array.isArray(items) ? items.indexOf(item) : -1;
  if (i < 0) return;
  items.splice(i, 1);
  try {
    torrent._updateSelections();
  } catch {
    // destroyed meanwhile
  }
}

/** A focus that follows a reader through a file: always the next pieces it will read. */
export class MovingFocus {
  constructor(file, priority = FOCUS_PRIORITY) {
    this.file = file;
    this.torrent = file._torrent;
    this.priority = priority;
    this.item = null;
    this.first = -1;
  }

  /** The reader is at this byte of the file now. */
  moveTo(byte) {
    const t = this.torrent;
    if (!t || t.destroyed || !t.pieceLength || this.file.length === 0) return;
    const pos = Math.min(Math.max(0, byte), this.file.length - 1);
    const first = Math.floor((this.file.offset + pos) / t.pieceLength);
    if (first === this.first && this.item) return;
    this.first = first;
    const lastOfFile = Math.floor((this.file.offset + this.file.length - 1) / t.pieceLength);
    const next = addFocus(t, first, Math.min(lastOfFile, first + focusPieces(t) - 1), this.priority);
    removeFocus(t, this.item);
    this.item = next;
  }

  clear() {
    removeFocus(this.torrent, this.item);
    this.item = null;
    this.first = -1;
  }
}

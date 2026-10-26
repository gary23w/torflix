// SPDX-License-Identifier: MIT OR Apache-2.0
// Display formatting helpers. Pure functions shared by main and renderer.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `1.5 GB` (decimal units). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** `2.4 MB/s`. */
export function formatRate(bps) {
  return `${formatBytes(bps)}/s`;
}

/** A whole percentage, clamped to 0–100. */
export function formatPercent(part, whole) {
  if (!(whole > 0)) return '0%';
  const pct = Math.min(100, Math.max(0, (part / whole) * 100));
  return `${Math.floor(pct)}%`;
}

/** `45 s`, `4 min`, `1 h 20 min`, or null. */
export function formatEtaLong(secs) {
  if (secs === null || secs === undefined || !Number.isFinite(secs) || secs < 0) return null;
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** `45s`, `3m 20s`, `1h 05m`, or `—`. */
export function formatEta(secs) {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '—';
  const total = Math.ceil(secs);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** `1:02:03` or `4:05`. */
export function formatTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** `3 days ago`, `yesterday`, or how long ago. */
export function formatPublished(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const y = Math.floor(days / 365);
  return y === 1 ? '1 year ago' : `${y} years ago`;
}

export function formatMillis(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

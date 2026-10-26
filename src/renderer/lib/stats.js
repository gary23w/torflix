// SPDX-License-Identifier: MIT OR Apache-2.0
// Player status arithmetic: smoothed rates, buffer health, ETAs, and when to preload the next
// video. Pure, so it can be reasoned about without a DOM.

/** Exponentially weighted moving average, so rates shown once a second do not jitter. */
export class Ewma {
  constructor(tauSecs = 3) {
    this.tau = tauSecs;
    this.value = null;
  }
  next(sample, dtSecs = 1) {
    if (!Number.isFinite(sample)) return this.value ?? 0;
    if (this.value === null) this.value = sample;
    else this.value += (1 - Math.exp(-Math.max(dtSecs, 0) / this.tau)) * (sample - this.value);
    return this.value;
  }
}

/** Green at 10 s or more ahead, yellow from 3 to 10 s, red below 3 s or while stalled. */
export function bufferHealth(bufferedSecs, stalled) {
  if (stalled) return 'stalled';
  if (bufferedSecs === null || !Number.isFinite(bufferedSecs)) return 'unknown';
  if (bufferedSecs >= 10) return 'good';
  return bufferedSecs >= 3 ? 'low' : 'stalled';
}

/** Seconds of media buffered ahead, from the backend or from bytes and the average rate. */
export function bufferedSeconds(backendSecs, bufferedBytes, fileLength, durationSecs) {
  if (backendSecs !== null && Number.isFinite(backendSecs)) return backendSecs;
  if (!Number.isFinite(durationSecs) || durationSecs <= 0 || !(fileLength > 0)) return null;
  return bufferedBytes / (fileLength / durationSecs);
}

export function etaSeconds(remainingBytes, bytesPerSec) {
  if (remainingBytes <= 0) return 0;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1024) return null;
  return remainingBytes / bytesPerSec;
}

/** The status line shown while waiting for video. */
export function loadingMessage({ firstFrameSeen, stalled, hasData, bufferedSecs, peers }) {
  if (!firstFrameSeen && !hasData) return peers > 0 ? `Connected to ${peers} peer${peers === 1 ? '' : 's'}, waiting for data…` : 'Finding peers…';
  if (!firstFrameSeen || stalled) {
    return bufferedSecs !== null && Number.isFinite(bufferedSecs) && bufferedSecs >= 1 ? `Buffering… ${Math.floor(bufferedSecs)}s ahead` : 'Buffering…';
  }
  return null;
}

export const PRELOAD_NEXT_LEAD_SECS = 120;
export const AUTOPLAY_COUNTDOWN_SECS = 5;

/** Whether the next queued video can be preloaded without slowing the current one. */
export function shouldPreloadNext({ fileDownloaded, fileLength, downloadBps, position, duration }) {
  if (fileLength > 0 && fileDownloaded >= fileLength) return true;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return false;
  const remaining = duration - position;
  if (remaining > PRELOAD_NEXT_LEAD_SECS || downloadBps <= 0) return false;
  const missing = Math.max(0, fileLength - fileDownloaded);
  return (missing / downloadBps) * 2 < remaining;
}

/** A cancellable countdown that ticks once a second. */
export class Countdown {
  constructor(onTick, onDone) {
    this.onTick = onTick;
    this.onDone = onDone;
    this.timer = undefined;
    this.left = 0;
  }
  get running() {
    return this.timer !== undefined;
  }
  start(seconds = AUTOPLAY_COUNTDOWN_SECS) {
    this.cancel();
    this.left = Math.max(1, Math.round(seconds));
    this.onTick(this.left);
    this.timer = setInterval(() => {
      this.left -= 1;
      if (this.left > 0) return this.onTick(this.left);
      this.cancel();
      this.onDone();
    }, 1000);
  }
  cancel() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.left = 0;
  }
}

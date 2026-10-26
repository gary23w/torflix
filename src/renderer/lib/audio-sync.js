// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Converted audio for a video whose own audio track the built-in player cannot decode (Dolby,
// DTS). FFmpeg makes an AAC stream from a given position; this plays it in an <audio> element
// next to the (silent) video and keeps the two together:
//
// - a stream is asked for a little ahead of the playhead and held until the video reaches its
//   start, so both begin on the same frame; the lead adapts to how long FFmpeg takes;
// - every seek starts a new stream at the new position;
// - pauses and buffering stop the audio with the video;
// - small drift is corrected by nudging the audio's playback rate, large drift by restarting.

const TICK_MS = 100;
/** Drift (seconds) that restarts the audio, and drift that starts nudging its rate. */
const RESTART_DRIFT = 0.45;
const NUDGE_DRIFT = 0.035;
const MAX_NUDGE = 0.08;
const MIN_LEAD = 0.5;
const MAX_LEAD = 6;

export class AudioSync {
  /**
   * @param {HTMLVideoElement} video
   * @param {(seconds: number) => string} urlAt the converted stream from a position
   */
  constructor(video, urlAt) {
    this.video = video;
    this.urlAt = urlAt;
    this.el = document.createElement('audio');
    this.el.preload = 'auto';
    this.offset = 0;
    this.pending = false;
    this.lead = 1.0;
    this.requestedAt = 0;
    this.timer = null;
    this.running = false;
    this.listeners = {
      seeking: () => this.restart(),
      pause: () => this.el.pause(),
      waiting: () => this.el.pause(),
      ended: () => this.el.pause(),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const [name, fn] of Object.entries(this.listeners)) this.video.addEventListener(name, fn);
    this.restart();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    for (const [name, fn] of Object.entries(this.listeners)) this.video.removeEventListener(name, fn);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }

  setVolume(volume, muted) {
    this.el.volume = volume;
    this.el.muted = muted;
  }

  /** Asks for a new stream starting a little ahead of the video. */
  restart(at = this.video.currentTime + this.lead) {
    if (!this.running) return;
    this.el.pause();
    this.offset = Math.max(0, at);
    this.pending = true;
    this.requestedAt = performance.now();
    this.el.src = this.urlAt(this.offset);
    this.el.load();
  }

  tick() {
    const v = this.video;
    const a = this.el;
    const running = !v.paused && !v.seeking && !v.ended && v.readyState >= 3;
    if (this.pending) {
      if (!running) return;
      const vt = v.currentTime;
      if (vt > this.offset + 0.15) {
        // FFmpeg took longer than the lead: ask again, further ahead.
        this.lead = Math.min(MAX_LEAD, this.lead * 1.6 + 0.3);
        this.restart(vt + this.lead);
        return;
      }
      if (a.readyState >= 3 && vt >= this.offset - 0.02) {
        this.pending = false;
        a.playbackRate = v.playbackRate;
        a.play().catch(() => {});
        // Next time, lead by about as long as this one really took.
        const took = (performance.now() - this.requestedAt) / 1000;
        this.lead = Math.min(MAX_LEAD, Math.max(MIN_LEAD, took * 0.8 + 0.3));
      }
      return;
    }
    if (!running) {
      if (!a.paused) a.pause();
      return;
    }
    if (a.paused) {
      a.play().catch(() => {});
      return;
    }
    const drift = this.offset + a.currentTime - v.currentTime; // positive: audio ahead
    if (Math.abs(drift) > RESTART_DRIFT) {
      this.restart();
      return;
    }
    const base = v.playbackRate;
    a.playbackRate = Math.abs(drift) > NUDGE_DRIFT ? base * (1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * 0.6))) : base;
  }

  /** For the debug overlay: how far the audio is from the video, in milliseconds. */
  driftMs() {
    if (!this.running || this.pending || this.el.paused) return null;
    return Math.round((this.offset + this.el.currentTime - this.video.currentTime) * 1000);
  }
}

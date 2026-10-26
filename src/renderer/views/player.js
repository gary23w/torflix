// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The player: a `<video>` fed by the loopback stream server, with controls overlaid on it,
// a seek bar that shows what is downloaded, subtitles from the torrent or a file, a debug
// overlay with a live piece map, the "Up next" countdown, and the resume prompt. Honest
// status instead of an endless spinner: peers, rate, and seconds buffered ahead.
//
// On Android TV the video plays in the TV's own player instead (`native`, the app's
// `tpNative`), which decodes what the built-in one cannot and reports the position itself; this
// view then keeps the status and a button to go back to the video.

import { h, icon, ICONS, replace, clear, closeOnOutside } from '../lib/dom.js';
import { formatRate, formatPercent, formatTime, formatEta, formatMillis, formatBytes } from '../../shared/format.js';
import { Ewma, bufferHealth, bufferedSeconds, etaSeconds, loadingMessage, Countdown } from '../lib/stats.js';
import { subtitleOptions, subtitleGroups, initialSubtitle, toggledSubtitle, rememberSubtitle, rememberedSubtitle, addCues, checkSubtitleFile, SUBTITLE_ACCEPT } from '../lib/subtitles.js';
import { AudioSync } from '../lib/audio-sync.js';
import { sendsNothing } from '../../shared/copies.js';

/** Seconds of playback after which a video with no decoded audio gets a hint. */
const SILENT_CHECK_SECS = 5;

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const STATS_MS = 1000;
const REPORT_MS = 5000;
const HIDE_CONTROLS_MS = 2600;
const SKIP_SECS = 5;
const BIG_SKIP_SECS = 10;
/** Subtitle files handed to the TV's player with a video. */
const MAX_NATIVE_SUBTITLES = 4;

const rateLabel = (r) => `${r}×`;

export class Player {
  constructor(stage, { api, settings, onEnded, onNext, onPrev, onToggleQueue, onError, nextItem, onNoData = null, native = null, onLeave = null }) {
    /** The TV's own player (Android TV), or null for the `<video>` here. */
    this.native = native;
    /** Called when the viewer leaves the TV's player before the end. */
    this.onLeave = onLeave;
    this.nativeOpen = false;
    this.nativeEnded = false;
    this.nativePosition = 0;
    this.nativeCenter = null;
    this.stage = stage;
    this.api = api;
    this.settings = settings;
    this.onEnded = onEnded;
    this.onNext = onNext;
    this.onPrev = onPrev;
    this.onToggleQueue = onToggleQueue;
    this.onError = onError;
    this.nextItem = nextItem;
    /** Called once per stream that sends nothing before its first frame (another copy may). */
    this.onNoData = onNoData;
    /** Bytes the torrent had received when this stream opened, and whether onNoData ran. */
    this.receivedAtLoad = null;
    this.noDataReported = false;
    this.info = null;
    this.stats = null;
    this.statsTimer = null;
    this.reportTimer = null;
    this.hideTimer = null;
    this.downEwma = new Ewma(3);
    this.upEwma = new Ewma(3);
    this.firstFrameSeen = false;
    this.stalled = false;
    this.loadedAt = 0;
    this.seekStartedAt = 0;
    this.lastSeekMs = null;
    this.firstFrameMs = null;
    this.subtitleList = null;
    this.locals = [];
    this.tracks = new Map();
    this.subtitle = null;
    this.lastSubtitle = null;
    this.debugOn = false;
    this.wasPlayingBeforeHide = false;
    // Volume and mute are the player's own, applied to whichever element makes the sound: the
    // video, or the converted audio when the video's own track cannot be decoded.
    this.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('tp.volume') ?? 1)));
    this.muted = localStorage.getItem('tp.muted') === '1';
    this.audioSync = null;
    this.audioInfo = null;
    this.silentTimer = null;
    this.countdown = new Countdown(
      (left) => this.renderUpNext(left),
      () => {
        this.hideUpNext();
        this.onNext();
      },
    );
    this.build();
  }

  // ----- building -----

  build() {
    this.video = h('video', { playsinline: true, preload: 'auto', disablepictureinpicture: true, controlslist: 'nodownload noremoteplayback' });
    const v = this.video;
    v.addEventListener('loadedmetadata', () => this.onMeta());
    v.addEventListener('loadeddata', () => this.onFirstFrame());
    v.addEventListener('playing', () => {
      this.onFirstFrame();
      this.stalled = false;
      this.renderCenter();
      this.renderControls();
      this.scheduleHide();
    });
    v.addEventListener('pause', () => {
      this.renderControls();
      this.showControls(true);
      this.report();
    });
    v.addEventListener('waiting', () => {
      this.stalled = true;
      this.renderCenter();
    });
    v.addEventListener('stalled', () => {
      if (!v.paused) {
        this.stalled = true;
        this.renderCenter();
      }
    });
    v.addEventListener('canplay', () => {
      this.stalled = false;
      this.renderCenter();
    });
    v.addEventListener('timeupdate', () => this.onTime());
    v.addEventListener('seeking', () => {
      this.seekStartedAt = performance.now();
      this.stalled = true;
      this.renderCenter();
    });
    v.addEventListener('seeked', () => {
      this.lastSeekMs = Math.round(performance.now() - this.seekStartedAt);
      this.report({ seek: true });
    });
    v.addEventListener('ended', () => {
      this.report({ ended: true });
      this.showControls(true);
      this.onEnded();
    });
    v.addEventListener('error', () => this.onMediaError());
    v.addEventListener('ratechange', () => this.renderControls());

    this.nowPlaying = h('div.now-playing', { hidden: true });
    // Subtitles are drawn here rather than by the browser, so they can rise above the controls.
    this.subLayer = h('div.subtitle-layer', { 'aria-live': 'off' });
    this.notice = h('div.player-notice', { hidden: true, role: 'status' });
    this.top = h('div.player-top');
    this.center = h('div.player-center');
    this.controls = h('div.controls', { role: 'group', 'aria-label': 'Playback controls' });
    this.debug = h('div.debug', { hidden: true, 'aria-live': 'off' });
    this.upNext = h('div.overlay-card.upnext', { hidden: true, role: 'dialog', 'aria-label': 'Up next' });
    this.resume = h('div.overlay-card.resume', { hidden: true, role: 'dialog', 'aria-label': 'Resume' });
    this.seek = this.buildSeekBar();
    this.el = h(
      'div.player',
      {
        onpointermove: () => this.showControls(),
        onpointerleave: () => this.scheduleHide(0),
        onclick: (e) => {
          if (e.target === this.video || e.target === this.nowPlaying || e.target.closest('.now-playing')) this.togglePlay();
        },
        ondblclick: (e) => {
          if (e.target === this.video) this.toggleFullscreen();
        },
      },
      this.video,
      this.nowPlaying,
      this.subLayer,
      this.top,
      this.notice,
      this.center,
      this.debug,
      this.controls,
      this.upNext,
      this.resume,
    );
    this.subtitleFile = h('input', {
      type: 'file',
      accept: SUBTITLE_ACCEPT,
      hidden: true,
      onchange: async () => {
        const file = this.subtitleFile.files?.[0];
        this.subtitleFile.value = '';
        if (!file) return;
        const problem = checkSubtitleFile(file);
        if (problem) return this.onError(new Error(problem));
        try {
          const cues = await this.api.parseSubtitles(new Uint8Array(await file.arrayBuffer()), file.name);
          const id = `local:${this.locals.length + 1}`;
          this.locals.push({ id, name: file.name, cues });
          this.chooseSubtitle(id);
        } catch (err) {
          this.onError(err);
        }
      },
    });
    this.el.append(this.subtitleFile);
    this.controls.append(this.seek.el, (this.controlsRow = h('div.row')));
    this.applyVolume();
    document.addEventListener('fullscreenchange', () => this.renderControls());
  }

  buildSeekBar() {
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const played = h('div.played');
    const knob = h('div.knob');
    const tip = h('div.tip');
    const track = h('div.track', null, canvas, played);
    const el = h('div.seekbar', { role: 'slider', 'aria-label': 'Seek', 'aria-valuemin': '0', tabindex: '0' }, track, knob, tip);
    let dragging = false;
    const fractionAt = (x) => {
      const r = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - r.left) / r.width));
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.duration) return;
      dragging = true;
      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
      this.scrubTo(fractionAt(e.clientX), false);
    });
    el.addEventListener('pointermove', (e) => {
      const f = fractionAt(e.clientX);
      tip.textContent = formatTime(f * (this.duration || 0));
      tip.style.left = `${f * 100}%`;
      if (dragging) this.scrubTo(f, false);
    });
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      this.scrubTo(fractionAt(e.clientX), true);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') (e.preventDefault(), this.skip(-SKIP_SECS));
      if (e.key === 'ArrowRight') (e.preventDefault(), this.skip(SKIP_SECS));
    });
    return { el, canvas, played, knob, tip };
  }

  // ----- loading -----

  /** Opens a stream in the player. */
  load(info) {
    this.unload(false);
    this.info = info;
    this.firstFrameSeen = false;
    this.stalled = true;
    this.loadedAt = performance.now();
    this.firstFrameMs = null;
    this.lastSeekMs = null;
    this.receivedAtLoad = null;
    this.noDataReported = false;
    this.duration = 0;
    this.mediaError = null;
    this.subtitleList = null;
    this.locals = [];
    this.tracks.clear();
    this.subtitle = null;
    this.lastSubtitle = null;
    this.downEwma = new Ewma(3);
    this.upEwma = new Ewma(3);
    this.el.classList.toggle('audio', info.kind === 'audio');
    this.nowPlaying.hidden = info.kind !== 'audio';
    if (info.kind === 'audio') {
      replace(this.nowPlaying, h('div.disc', null, h('div.art', null, icon(ICONS.music, { size: 48 })), h('h2', null, info.fileName), h('p', null, info.torrentName)));
    }
    replace(this.top, h('span.title', { title: info.fileName }, info.fileName), info.torrentName && info.torrentName !== info.fileName ? h('span.torrent-name', null, '· ', info.torrentName) : null, h('span.spacer'));
    if (this.native) return this.loadNative(info);
    this.video.playbackRate = this.settings().playback.defaultSpeed;
    this.video.src = info.url;
    this.video.load();
    const resume = info.resumePositionSecs;
    // Chosen on the title page (Resume, or Play from start): not asked again.
    if (resume !== null && resume > 0 && !info.resumeChosen) this.showResume(resume);
    else this.resumeFrom(resume ?? 0);
    this.statsTimer = setInterval(() => this.pollStats(), STATS_MS);
    this.reportTimer = setInterval(() => this.report(), REPORT_MS);
    this.pollStats();
    this.loadSubtitleList();
    // The audio check reads the file too. Once the video has opened, the bytes it reads are on
    // disk: it neither waits on the swarm nor competes with the start for the connection.
    const audioWhenOpen = () => this.info === info && this.setupAudio(info);
    if (this.video.readyState >= 1) audioWhenOpen();
    else this.video.addEventListener('loadedmetadata', audioWhenOpen, { once: true });
    this.renderCenter();
    this.renderControls();
    this.showControls();
  }

  // ----- the TV's own player (Android TV) -----

  loadNative(info) {
    this.el.classList.add('native');
    this.nativeEnded = false;
    this.nativePosition = info.resumePositionSecs ?? 0;
    this.statsTimer = setInterval(() => this.pollStats(), STATS_MS);
    this.pollStats();
    this.playNative(info, this.nativePosition);
  }

  /**
   * The TV's player opens the moment Play is pressed, saying "Opening…", and takes the video as
   * soon as the stream is ready: building it overlaps finding the torrent's peers. `playId` is
   * the press, so a later one is never confused with it.
   */
  prepareNative(playId, title) {
    if (!this.native?.prepare) return;
    this.pendingPlayId = playId;
    this.openingDismissed = false;
    this.native.prepare(JSON.stringify({ playId, title }));
  }

  /** That press came to nothing (the start failed): its waiting player closes. */
  cancelNative(playId) {
    if (!this.native?.cancel || this.pendingPlayId !== playId) return;
    this.pendingPlayId = null;
    this.native.cancel(playId);
  }

  /** Opens (or reopens) the stream in the TV's player at `positionSecs`. */
  playNative(info, positionSecs) {
    // The viewer pressed Back while it was still opening: it is not brought back unasked.
    if (this.openingDismissed) {
      this.openingDismissed = false;
      this.nativeOpen = false;
      this.renderCenter();
      return;
    }
    this.nativeOpen = true;
    this.renderCenter();
    const playId = this.pendingPlayId ?? -1;
    this.pendingPlayId = null;
    this.native.play(JSON.stringify({ playId, streamId: info.streamId, url: info.url, title: info.fileName, resumePositionSecs: positionSecs, subtitles: this.nativeSubtitles(info) }));
  }

  /** Back to the video after leaving the TV's player, where it was left. */
  resumeNative() {
    if (!this.native || !this.info || this.nativeOpen) return;
    this.mediaError = null;
    this.nativeEnded = false;
    this.playNative(this.info, this.nativePosition);
  }

  /**
   * The video's own subtitle files, the one to show first marked `selected`, as addresses on
   * the stream server, which serves each as SRT once it is in: the TV's player loads them
   * itself and starts the video without waiting for them.
   */
  nativeSubtitles(info) {
    if (!Array.isArray(info.subtitles)) return [];
    this.subtitleList = { files: info.subtitles, embedded: [] };
    const urls = new Map(info.subtitles.map((f) => [`file:${f.index}`, f.url]));
    const options = this.options().filter((o) => o.enabled && o.id.startsWith('file:') && urls.get(o.id));
    const first = initialSubtitle(options, rememberedSubtitle(), this.settings().playback.subtitlesByDefault, navigator.languages);
    const picked = [...options.filter((o) => o.id === first), ...options.filter((o) => o.id !== first && o.group === 'video')].slice(0, MAX_NATIVE_SUBTITLES);
    return picked.map((o) => ({ label: o.label, language: o.language, selected: o.id === first, url: urls.get(o.id) }));
  }

  /** What the TV's player reports: `{ type, streamId, positionSecs, durationSecs, message? }`. */
  handleNative(ev) {
    // Back pressed on the player while it was still opening: the viewer left this Play.
    if (ev?.type === 'closed' && ev.playId !== undefined && ev.playId !== -1 && ev.playId === this.pendingPlayId) {
      this.pendingPlayId = null;
      this.openingDismissed = true;
      this.onLeave?.();
      return;
    }
    const info = this.info;
    if (!info || !ev || ev.streamId !== info.streamId) return;
    if (Number.isFinite(ev.durationSecs) && ev.durationSecs > 0) this.duration = ev.durationSecs;
    if (Number.isFinite(ev.positionSecs)) this.nativePosition = ev.positionSecs;
    if (ev.type === 'firstFrame') this.onFirstFrame();
    else if (ev.type === 'ended') {
      this.nativeEnded = true;
      this.onEnded();
    } else if (ev.type === 'nodata') {
      // The TV's player gave up on a copy that sent nothing (the desktop's rule, which this page
      // cannot run while the TV's player covers it): another copy of the title may have peers.
      this.nativeOpen = false;
      if (!this.noDataReported) {
        this.noDataReported = true;
        this.onNoData?.(info, { peers: this.stats?.peersLive ?? 0, receivedBytes: 0 });
      }
      return;
    } else if (ev.type === 'error') {
      // The TV's player closes after an error, and this view with it: the message goes in a toast.
      this.mediaError = ev.message || 'The TV could not play this file.';
      this.stalled = false;
      this.onError(new Error(this.mediaError));
    } else if (ev.type === 'closed') {
      const left = this.nativeOpen && !this.nativeEnded;
      this.nativeOpen = false;
      this.renderCenter();
      if (left) this.onLeave?.();
      return;
    }
    this.renderCenter();
  }

  /** The middle of the view while the TV's player has the video, or after it closed. */
  renderNativeCenter() {
    let key;
    let content;
    if (this.mediaError) {
      key = `error:${this.mediaError}`;
      content = h('div.loading', { role: 'alert' }, this.mediaError);
    } else if (!this.firstFrameSeen) {
      const s = this.stats;
      const msg = loadingMessage({ firstFrameSeen: false, stalled: true, hasData: (s?.fileDownloaded ?? 0) > 0, bufferedSecs: this.bufferedSecs(), peers: s?.peersLive ?? 0 });
      key = `loading:${msg}`;
      content = h('div.loading', null, h('span.spinner'), msg ?? 'Opening…');
    } else if (this.nativeOpen) {
      key = 'open';
      content = h('div.loading', null, 'Playing on the TV');
    } else if (this.nativeEnded) {
      key = 'ended';
      content = null;
    } else {
      key = 'closed';
      content = h(
        'button.btn.primary.native-resume',
        { type: 'button', onclick: () => this.resumeNative() },
        icon(ICONS.play, { size: 20 }),
        this.nativePosition > 0 ? ` Resume from ${formatTime(this.nativePosition)}` : ' Play',
      );
    }
    if (key === this.nativeCenter) return;
    this.nativeCenter = key;
    replace(this.center, content);
    if (key === 'closed' && this.el.closest('.view.active')) this.center.querySelector('button')?.focus();
  }

  // ----- audio the built-in player cannot decode -----

  /**
   * Asks which audio track plays and whether it needs converting. Dolby and DTS tracks play
   * through FFmpeg as converted audio next to the video; without FFmpeg the viewer is told
   * why there is no sound.
   */
  async setupAudio(info) {
    let a;
    try {
      a = await this.api.streamAudio(info.streamId, navigator.languages);
    } catch {
      return;
    }
    if (this.info !== info) return;
    this.audioInfo = a;
    const track = a.chosen === null ? null : a.tracks[a.chosen];
    if (a.convert && a.url) {
      this.audioSync = new AudioSync(this.video, (t) => `${a.url}?t=${t.toFixed(3)}&track=${a.chosen}`);
      this.audioSync.start();
      this.applyVolume();
      this.top.querySelector('.audio-note')?.remove();
      this.top.querySelector('.spacer')?.before(h('span.audio-note', { title: `${track.label}: converted to AAC by FFmpeg as it plays` }, `· ${track.codecLabel} audio, converted`));
    } else if (a.needsConversion) {
      this.showNotice(`No sound: this video's audio is ${track.codecLabel}, which the built-in player cannot decode. Install FFmpeg (for example: winget install Gyan.FFmpeg), restart Torflix, and it converts the audio as it plays.`);
    } else if (!a.probed && !a.ffmpeg) {
      // Without ffprobe the format is unknown: notice silence instead.
      clearTimeout(this.silentTimer);
      this.silentTimer = setTimeout(() => this.checkSilent(info), 1000);
    }
  }

  checkSilent(info) {
    if (this.info !== info) return;
    const v = this.video;
    if (v.currentTime < SILENT_CHECK_SECS || v.paused) {
      this.silentTimer = setTimeout(() => this.checkSilent(info), 1000);
      return;
    }
    if (info.kind === 'video' && v.webkitAudioDecodedByteCount === 0) {
      this.showNotice('No sound could be decoded. If this video has Dolby or DTS audio (common in WEB-DL and BluRay releases), install FFmpeg (for example: winget install Gyan.FFmpeg) and restart Torflix: it converts that audio as the video plays.');
    }
  }

  showNotice(text) {
    replace(this.notice, h('span', null, text), h('button.notice-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => (this.notice.hidden = true) }, '×'));
    this.notice.hidden = false;
  }

  /** Applies the player's volume to whichever element makes the sound, and remembers it. */
  applyVolume() {
    if (this.audioSync) {
      this.video.muted = true;
      this.audioSync.setVolume(this.volume, this.muted);
    } else {
      this.video.volume = this.volume;
      this.video.muted = this.muted;
    }
    try {
      localStorage.setItem('tp.volume', String(this.volume));
      localStorage.setItem('tp.muted', this.muted ? '1' : '0');
    } catch {
      // storage unavailable
    }
    this.renderControls();
  }

  /** Closes the player's view of the stream (the stream itself is the shell's to stop). */
  unload(clearInfo = true) {
    // Only this stream's player: a newer one may already be opening for the next video.
    if (this.nativeOpen) (this.native.stopStream ? this.native.stopStream(this.info?.streamId ?? -1) : this.native.stop());
    this.nativeOpen = false;
    this.nativeEnded = false;
    this.nativeCenter = null;
    this.el.classList.remove('native');
    clearInterval(this.statsTimer);
    clearInterval(this.reportTimer);
    this.statsTimer = null;
    this.reportTimer = null;
    this.countdown.cancel();
    this.hideUpNext();
    this.resume.hidden = true;
    if (this.info) this.report();
    this.audioSync?.stop();
    this.audioSync = null;
    this.audioInfo = null;
    clearTimeout(this.silentTimer);
    this.notice.hidden = true;
    this.top.querySelector('.audio-note')?.remove();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.applyVolume();
    for (const t of this.tracks.values()) {
      t.mode = 'disabled';
      t.oncuechange = null;
    }
    this.tracks.clear();
    clear(this.subLayer);
    this.stats = null;
    if (clearInfo) {
      this.info = null;
      clear(this.top);
      this.renderCenter();
      this.renderControls();
    }
  }

  get active() {
    return this.info !== null;
  }

  /** Leaving the Playing view: pause, remember whether it played. */
  hide() {
    this.wasPlayingBeforeHide = this.active && !this.video.paused && !this.video.ended;
    if (this.active) this.video.pause();
    this.countdown.cancel();
    this.hideUpNext();
  }

  /** Back to the Playing view: pick up where it was. */
  reveal() {
    // On a TV, the remote lands on Resume.
    if (this.native) return this.center.querySelector('.native-resume')?.focus();
    if (this.active && this.wasPlayingBeforeHide) this.video.play().catch(() => {});
    this.showControls();
  }

  // ----- playback -----

  togglePlay() {
    if (!this.active) return;
    if (!this.resume.hidden) return this.resumeFrom(this.pendingResume);
    if (this.video.paused || this.video.ended) this.video.play().catch(() => {});
    else this.video.pause();
  }

  skip(secs) {
    if (!this.active || !this.duration) return;
    this.video.currentTime = Math.min(this.duration, Math.max(0, this.video.currentTime + secs));
    this.showControls();
  }

  scrubTo(fraction, commit) {
    if (!this.duration) return;
    const t = fraction * this.duration;
    this.seek.played.style.width = `${fraction * 100}%`;
    this.seek.knob.style.left = `${fraction * 100}%`;
    if (commit) {
      this.video.currentTime = t;
      this.showControls();
    }
  }

  setRate(rate) {
    this.video.playbackRate = rate;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (v > 0) this.muted = false;
    this.applyVolume();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.stage.requestFullscreen().catch(() => {});
  }

  toggleDebug() {
    if (!this.settings().advanced.debugOverlay) return;
    this.debugOn = !this.debugOn;
    this.debug.hidden = !this.debugOn;
    this.renderDebug();
  }

  /** Keyboard shortcuts; returns true when handled. */
  handleKey(e) {
    if (!this.active && e.key !== 'q' && e.key !== 'Q') return false;
    const k = e.key;
    if (k === ' ' || k === 'k' || k === 'K') this.togglePlay();
    else if (k === 'ArrowLeft') this.skip(-SKIP_SECS);
    else if (k === 'ArrowRight') this.skip(SKIP_SECS);
    else if (k === 'j' || k === 'J') this.skip(-BIG_SKIP_SECS);
    else if (k === 'l' || k === 'L') this.skip(BIG_SKIP_SECS);
    else if (k === 'ArrowUp') this.setVolume(Math.min(1, this.volume + 0.05));
    else if (k === 'ArrowDown') this.setVolume(Math.max(0, this.volume - 0.05));
    else if (k === 'f' || k === 'F') this.toggleFullscreen();
    else if (k === 'm' || k === 'M') this.toggleMute();
    else if (k === 'c' || k === 'C') this.chooseSubtitle(toggledSubtitle(this.options(), this.subtitle, this.lastSubtitle, navigator.languages));
    else if (k === 'd' || k === 'D') this.toggleDebug();
    else if (k === 'N' && e.shiftKey) this.onNext();
    else if (k === 'P' && e.shiftKey) this.onPrev();
    else if (k === 'Escape') {
      if (this.countdown.running) this.cancelUpNext();
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else return false;
    } else if (/^[0-9]$/.test(k) && this.duration) this.video.currentTime = (Number(k) / 10) * this.duration;
    else if (k === '<' || k === ',') this.setRate(RATES[Math.max(0, RATES.indexOf(this.video.playbackRate) - 1)] ?? 1);
    else if (k === '>' || k === '.') this.setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(this.video.playbackRate) + 1)] ?? 1);
    else return false;
    this.showControls();
    return true;
  }

  // ----- events -----

  onMeta() {
    this.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.seek.el.setAttribute('aria-valuemax', String(Math.floor(this.duration)));
    this.report();
    this.renderControls();
  }

  onFirstFrame() {
    if (this.firstFrameSeen) return;
    this.firstFrameSeen = true;
    this.firstFrameMs = Math.round(performance.now() - this.loadedAt);
    this.stalled = false;
    this.renderCenter();
    this.report();
  }

  onTime() {
    if (!this.duration || this.seek.el.classList.contains('dragging')) return;
    const f = this.video.currentTime / this.duration;
    this.seek.played.style.width = `${f * 100}%`;
    this.seek.knob.style.left = `${f * 100}%`;
    this.seek.el.setAttribute('aria-valuenow', String(Math.floor(this.video.currentTime)));
    this.seek.el.setAttribute('aria-valuetext', `${formatTime(this.video.currentTime)} of ${formatTime(this.duration)}`);
    if (this.timeEl) this.timeEl.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(this.duration)}`;
  }

  async onMediaError() {
    if (!this.info) return;
    const info = this.info;
    const code = this.video.error?.code;
    // A stream that no longer exists answers 404, which reads as "not supported": say so plainly.
    const alive = await this.api.streamStats(info.streamId).then(() => true, (err) => err?.kind !== 'noSuchStream');
    if (this.info !== info) return;
    if (!alive) {
      this.mediaError = 'This video was stopped.';
      this.stalled = false;
      return this.renderCenter();
    }
    const msg =
      code === 4
        ? 'The built-in player cannot play this file: its container or codec is not supported. Try a release marked “plays in built-in player” (MP4 or WebM with H.264/VP9/AV1 and AAC/Opus audio).'
        : code === 3
          ? 'The video could not be decoded. Its codec may not be supported by the built-in player.'
          : code === 2
            ? 'The stream was interrupted. Press play to try again.'
            : 'Playback failed.';
    this.mediaError = msg;
    this.stalled = false;
    this.renderCenter();
  }

  async pollStats() {
    if (!this.info) return;
    let s;
    try {
      s = await this.api.streamStats(this.info.streamId);
    } catch {
      return;
    }
    if (!this.info) return;
    this.stats = s;
    this.checkNoData(s);
    this.downRate = this.downEwma.next(s.downloadBps);
    this.upRate = this.upEwma.next(s.uploadBps);
    this.drawPieces();
    this.renderStatus();
    this.renderCenter();
    if (this.debugOn) this.renderDebug();
  }

  /** Tells the app when this copy has sent nothing since it opened (no frame, almost no bytes). */
  checkNoData(s) {
    if (this.noDataReported || this.firstFrameSeen || !this.onNoData) return;
    this.receivedAtLoad ??= s.receivedBytes ?? 0;
    const receivedBytes = (s.receivedBytes ?? 0) - this.receivedAtLoad;
    if (!sendsNothing({ elapsedMs: performance.now() - this.loadedAt, firstFrame: this.firstFrameSeen, receivedBytes })) return;
    this.noDataReported = true;
    this.onNoData(this.info, { peers: s.peersLive ?? 0, receivedBytes });
  }

  report(extra = {}) {
    // The TV's player reports its own position.
    if (!this.info || this.native) return;
    this.api
      .reportPlayback(this.info.streamId, {
        positionSecs: this.video.currentTime,
        durationSecs: this.duration,
        ended: extra.ended === true,
        seek: extra.seek === true,
        firstFrameMs: this.firstFrameMs ?? undefined,
        lastSeekMs: this.lastSeekMs ?? undefined,
      })
      .catch(() => {});
  }

  // ----- subtitles -----

  options() {
    return subtitleOptions(this.subtitleList, this.locals);
  }

  async loadSubtitleList() {
    const info = this.info;
    try {
      const list = await this.api.streamSubtitles(info.streamId);
      if (this.info !== info) return;
      this.subtitleList = list;
      const initial = initialSubtitle(this.options(), rememberedSubtitle(), this.settings().playback.subtitlesByDefault, navigator.languages);
      if (initial) this.chooseSubtitle(initial, false);
      this.renderControls();
    } catch {
      // no subtitles
    }
  }

  async chooseSubtitle(id, remember = true) {
    for (const t of this.tracks.values()) t.mode = 'disabled';
    this.subtitle = id;
    if (remember) rememberSubtitle(id === null ? null : this.options().find((o) => o.id === id) ?? null);
    this.renderControls();
    this.renderCues();
    if (id === null) return;
    this.lastSubtitle = id;
    let track = this.tracks.get(id);
    if (!track) {
      const option = this.options().find((o) => o.id === id);
      if (!option) return;
      let cues;
      try {
        if (id.startsWith('file:')) cues = await this.api.loadSubtitles(this.info.streamId, Number(id.slice(5)));
        else cues = this.locals.find((l) => l.id === id)?.cues;
      } catch (err) {
        this.onError(err);
        this.subtitle = null;
        this.renderControls();
        return;
      }
      if (!cues || this.subtitle !== id) return;
      track = this.video.addTextTrack('subtitles', option.label, option.language || undefined);
      addCues(track, cues.cues);
      track.oncuechange = () => this.renderCues();
      this.tracks.set(id, track);
    }
    // Hidden: the browser keeps time and reports the active cues; the player draws them.
    track.mode = 'hidden';
    this.renderCues();
  }

  /** Draws the active subtitle lines (as plain text) in the player's subtitle layer. */
  renderCues() {
    const track = this.subtitle === null ? null : this.tracks.get(this.subtitle);
    if (!track || track.mode === 'disabled' || !track.activeCues) return clear(this.subLayer);
    const lines = [...track.activeCues].sort((a, b) => a.startTime - b.startTime).map((c) => c.plainText ?? c.text);
    replace(this.subLayer, lines.map((text) => h('span.subtitle-line', null, text)));
  }

  // ----- overlays -----

  showResume(secs) {
    this.pendingResume = secs;
    replace(
      this.resume,
      h('p.eyebrow', null, 'Continue watching'),
      h('p.headline', null, `You stopped at ${formatTime(secs)}.`),
      h(
        'div.buttons',
        null,
        h('button.btn.primary', { type: 'button', onclick: () => this.resumeFrom(secs) }, `Resume from ${formatTime(secs)}`),
        h('button.btn.secondary', { type: 'button', onclick: () => this.resumeFrom(0) }, 'Start over'),
      ),
    );
    this.resume.hidden = false;
    this.resume.querySelector('button')?.focus();
  }

  resumeFrom(secs) {
    this.resume.hidden = true;
    const start = () => {
      if (secs > 0) this.video.currentTime = secs;
      this.video.play().catch(() => {});
    };
    if (this.video.readyState >= 1) start();
    else this.video.addEventListener('loadedmetadata', start, { once: true });
  }

  /** Shows the "Up next" card and starts the countdown. */
  showUpNext(next) {
    this.pendingNext = next;
    this.countdown.start();
    this.upNext.hidden = false;
  }

  cancelUpNext() {
    this.countdown.cancel();
    this.hideUpNext();
  }

  hideUpNext() {
    this.upNext.hidden = true;
    clear(this.upNext);
  }

  renderUpNext(left) {
    const next = this.pendingNext;
    if (!next) return;
    replace(
      this.upNext,
      h('p.eyebrow', null, 'Up next in ', h('span.count', null, String(left)), ' s'),
      h('p.headline', { title: next.title }, next.title),
      h(
        'div.buttons',
        null,
        h('button.btn.primary', { type: 'button', onclick: () => (this.cancelUpNext(), this.onNext()) }, 'Play now'),
        h('button.btn.secondary', { type: 'button', onclick: () => this.cancelUpNext() }, 'Cancel (Esc)'),
      ),
    );
  }

  // ----- rendering -----

  showControls(keep = false) {
    this.el.classList.add('controls-visible');
    this.el.classList.remove('hide-cursor');
    if (!keep) this.scheduleHide();
    else clearTimeout(this.hideTimer);
  }

  scheduleHide(ms = HIDE_CONTROLS_MS) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.active || this.video.paused || this.menuOpen || this.controls.matches(':hover') || this.controls.contains(document.activeElement)) return;
      this.el.classList.remove('controls-visible');
      if (this.info?.kind !== 'audio') this.el.classList.add('hide-cursor');
    }, ms);
  }

  renderCenter() {
    if (!this.active) {
      this.nativeCenter = null;
      return clear(this.center);
    }
    if (this.native) return this.renderNativeCenter();
    if (this.mediaError) return replace(this.center, h('div.loading', { role: 'alert' }, this.mediaError));
    const s = this.stats;
    const msg = loadingMessage({
      firstFrameSeen: this.firstFrameSeen,
      stalled: this.stalled && !this.video.paused,
      hasData: (s?.fileDownloaded ?? 0) > 0,
      bufferedSecs: this.bufferedSecs(),
      peers: s?.peersLive ?? 0,
    });
    if (msg) return replace(this.center, h('div.loading', null, h('span.spinner'), msg));
    if (this.video.paused && this.resume.hidden && !this.video.ended) return replace(this.center, h('button.big-play', { type: 'button', 'aria-label': 'Play', onclick: () => this.togglePlay() }, icon(ICONS.play, { size: 34 })));
    clear(this.center);
  }

  bufferedSecs() {
    const s = this.stats;
    if (!s) return null;
    return bufferedSeconds(s.bufferedSecs, s.bufferedBytes, s.fileLength, this.duration);
  }

  renderStatus() {
    if (!this.statusEl || !this.stats) return;
    const s = this.stats;
    const secs = this.bufferedSecs();
    const health = bufferHealth(secs, this.stalled && !this.video.paused && this.firstFrameSeen);
    const complete = s.fileLength > 0 && s.fileDownloaded >= s.fileLength;
    const eta = etaSeconds(s.fileLength - s.fileDownloaded, this.downRate ?? 0);
    replace(
      this.statusEl,
      h('span', { title: 'Download and upload speed' }, `↓ ${formatRate(this.downRate ?? 0)} ↑ ${formatRate(this.upRate ?? 0)}`),
      h('span.sep', null, '·'),
      h('span', { title: `${s.peersLive} connected · ${s.peersConnecting} connecting · ${s.peersSeen} seen` }, `${s.peersLive} peer${s.peersLive === 1 ? '' : 's'}`),
      h('span.sep', null, '·'),
      h('span', { title: 'Media buffered ahead of the playhead' }, h('span.health-dot', { class: health }), secs === null ? '—' : `${Math.floor(Math.max(0, secs))}s ahead`),
      h('span.sep', null, '·'),
      h('span', { title: 'Share of this file downloaded' }, formatPercent(s.fileDownloaded, s.fileLength)),
      complete ? null : [h('span.sep', null, '·'), h('span', { title: 'Time to download the rest of this file' }, `ETA ${formatEta(eta)}`)],
    );
  }

  drawPieces() {
    const { canvas } = this.seek;
    const s = this.stats;
    const w = canvas.clientWidth || 600;
    const hgt = 8;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== hgt) canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, hgt);
    if (!s?.pieceMap?.length) return;
    const cells = s.pieceMap.length;
    const cw = w / cells;
    for (let i = 0; i < cells; i++) {
      const v = s.pieceMap[i];
      if (v === 0) continue;
      ctx.fillStyle = `rgba(255,255,255,${0.18 + 0.42 * (v / 255)})`;
      ctx.fillRect(Math.floor(i * cw), 0, Math.ceil(cw), hgt);
    }
    if (this.debugCanvas && this.debugOn) {
      const dc = this.debugCanvas;
      dc.width = dc.clientWidth || 320;
      dc.height = 14;
      const dctx = dc.getContext('2d');
      dctx.fillStyle = '#222';
      dctx.fillRect(0, 0, dc.width, dc.height);
      const dw = dc.width / cells;
      for (let i = 0; i < cells; i++) {
        const v = s.pieceMap[i];
        if (v === 0) continue;
        dctx.fillStyle = v === 255 ? '#57b26f' : `rgba(217,180,74,${0.3 + 0.7 * (v / 255)})`;
        dctx.fillRect(Math.floor(i * dw), 0, Math.ceil(dw), dc.height);
      }
      if (s.fileLength > 0) {
        dctx.fillStyle = '#f2b45a';
        dctx.fillRect(Math.floor((s.positionBytes / s.fileLength) * dc.width) - 1, 0, 2, dc.height);
      }
    }
  }

  renderDebug() {
    const s = this.stats;
    if (!s) return;
    if (!this.debugCanvas) this.debugCanvas = h('canvas', { 'aria-hidden': 'true' });
    const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
    replace(
      this.debug,
      h('div', { style: { color: '#f2b45a', marginBottom: '0.2rem' } }, 'Debug (D to hide)'),
      h(
        'dl',
        null,
        row('engine', s.engine ?? '–'),
        row('state', s.state),
        row('down / up', `${formatRate(s.downloadBps)} / ${formatRate(s.uploadBps)}`),
        row('peers', `${s.peersLive} live · ${s.peersConnecting} connecting · ${s.peersSeen} seen`),
        row('file', `${formatBytes(s.fileDownloaded)} of ${formatBytes(s.fileLength)}`),
        row('playhead', `${formatBytes(s.positionBytes)} (${formatPercent(s.positionBytes, s.fileLength)})`),
        row('buffered', `${formatBytes(s.bufferedBytes)}${this.bufferedSecs() !== null ? ` ≈ ${Math.floor(this.bufferedSecs())} s` : ''}`),
        row('first byte', formatMillis(s.serverFirstByteMs)),
        row('first frame', formatMillis(this.firstFrameMs)),
        row('last seek', `${formatMillis(this.lastSeekMs)} (${s.seeks} seeks)`),
        row('video', `${this.video.videoWidth}×${this.video.videoHeight} · ${this.video.playbackRate}× · readyState ${this.video.readyState}`),
        row('audio', this.audioDebug()),
      ),
      this.debugCanvas,
    );
    this.drawPieces();
  }

  audioDebug() {
    const a = this.audioInfo;
    if (!a) return '–';
    if (!a.probed) return a.ffmpeg ? 'not probed' : 'unknown (no FFmpeg)';
    const track = a.chosen === null ? null : a.tracks[a.chosen];
    if (!track) return 'no audio track';
    if (!this.audioSync) return `${track.label}${track.decodes ? '' : ' · not decodable'}`;
    const drift = this.audioSync.driftMs();
    return `${track.label} → AAC (FFmpeg)${drift === null ? '' : ` · drift ${drift} ms`}`;
  }

  renderControls() {
    if (!this.controlsRow) return;
    const v = this.video;
    const paused = v.paused || v.ended;
    const fs = Boolean(document.fullscreenElement);
    const options = this.options();
    const ctl = (ic, label, onclick, { on = false, fill = false, title = label } = {}) =>
      h('button.ctl', { type: 'button', class: `${on ? 'on' : ''} ${fill ? 'fill' : ''}`, 'aria-label': label, title, onclick }, icon(ic));
    this.timeEl = h('span.time', null, `${formatTime(v.currentTime)} / ${formatTime(this.duration)}`);
    this.statusEl = h('div.status');
    const rateMenu = h('div.menu');
    const renderRate = (open) => {
      replace(
        rateMenu,
        h('button.text-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false', 'aria-label': 'Playback speed', title: 'Playback speed (< >)', onclick: () => renderRate(!open) }, rateLabel(v.playbackRate)),
        open
          ? h(
              'ul.popup.up',
              { role: 'listbox', 'aria-label': 'Playback speed' },
              RATES.map((r) => h('li', null, h('button', { type: 'button', role: 'option', 'aria-selected': r === v.playbackRate ? 'true' : 'false', class: r === v.playbackRate ? 'selected' : '', onclick: () => (this.setRate(r), renderRate(false)) }, rateLabel(r)))),
            )
          : null,
      );
      this.menuOpen = open;
      if (open) closeOnOutside(rateMenu, () => renderRate(false));
    };
    renderRate(false);
    const ccMenu = h('div.menu');
    const renderCc = (open) => {
      const groups = subtitleGroups(options);
      replace(
        ccMenu,
        ctl(ICONS.cc, this.subtitle === null ? 'Subtitles (off)' : 'Subtitles (on)', () => renderCc(!open), { on: this.subtitle !== null, title: 'Subtitles (C)' }),
        open
          ? h(
              'ul.popup.up.right',
              { role: 'listbox', 'aria-label': 'Subtitles' },
              options.length === 0 ? h('li.heading', { role: 'presentation' }, 'No subtitles in this torrent') : null,
              options.length > 0 ? h('li', null, h('button', { type: 'button', role: 'option', class: this.subtitle === null ? 'selected' : '', onclick: () => (this.chooseSubtitle(null), renderCc(false)) }, 'Off')) : null,
              groups.map((g) => [
                g.title ? h('li.heading', { role: 'presentation' }, g.title) : null,
                g.options.map((o) =>
                  h(
                    'li',
                    null,
                    h(
                      'button',
                      { type: 'button', role: 'option', disabled: !o.enabled, class: o.id === this.subtitle ? 'selected' : '', onclick: () => (this.chooseSubtitle(o.id), renderCc(false)) },
                      h('span.label', null, o.label),
                      o.detail ? h('span.detail', null, o.detail) : null,
                    ),
                  ),
                ),
              ]),
              h('li.divider', { role: 'presentation' }),
              h('li', null, h('button', { type: 'button', onclick: () => (renderCc(false), this.subtitleFile.click()) }, 'Load subtitle file…')),
            )
          : null,
      );
      this.menuOpen = open;
      if (open) closeOnOutside(ccMenu, () => renderCc(false));
    };
    renderCc(false);
    const next = this.nextItem();
    replace(
      this.controlsRow,
      ctl(paused ? ICONS.play : ICONS.pause, paused ? 'Play' : 'Pause', () => this.togglePlay(), { fill: true, title: paused ? 'Play (Space)' : 'Pause (Space)' }),
      ctl(ICONS.next, 'Next', () => this.onNext(), { fill: true, title: next ? `Next: ${next.title} (Shift+N)` : 'Next (Shift+N)' }),
      this.timeEl,
      rateMenu,
      ctl(this.muted || this.volume === 0 ? ICONS.muted : ICONS.volume, this.muted || this.volume === 0 ? 'Unmute' : 'Mute', () => this.toggleMute(), { title: 'Mute (M)' }),
      h('input.volume', { type: 'range', min: '0', max: '1', step: '0.05', value: String(this.muted ? 0 : this.volume), 'aria-label': 'Volume', oninput: (e) => this.setVolume(Number(e.target.value)) }),
      h('span.spacer'),
      this.statusEl,
      h('span.spacer'),
      ccMenu,
      this.settings().advanced.debugOverlay ? ctl(ICONS.debug, 'Debug overlay', () => this.toggleDebug(), { on: this.debugOn, title: 'Debug overlay (D)' }) : null,
      ctl(fs ? ICONS.exitFullscreen : ICONS.fullscreen, fs ? 'Exit fullscreen' : 'Fullscreen', () => this.toggleFullscreen(), { title: 'Fullscreen (F)' }),
    );
    this.renderStatus();
  }
}

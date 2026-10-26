// SPDX-License-Identifier: MIT OR Apache-2.0
// The Settings page: playback, storage, bandwidth and seeding, search, network, advanced, about.

import { h, replace } from '../lib/dom.js';
import { formatBytes } from '../../shared/format.js';

/** What turning the metadata service back on sets (the main process' default). */
const DEFAULT_META_SERVICE = 'https://torflix-meta.vercel.app';

export class SettingsView {
  constructor(root, { api, onChanged, onError }) {
    this.root = root;
    this.api = api;
    this.onChanged = onChanged;
    this.onError = onError;
    this.view = null;
    this.info = null;
    this.usage = null;
    this.fieldErrors = new Map();
    this.render();
  }

  setView(view) {
    this.view = view;
    this.render();
  }

  async refresh() {
    try {
      const [view, info] = await Promise.all([this.api.getSettings(), this.info ?? this.api.appInfo()]);
      this.info = info;
      this.view = view;
      this.render();
      [this.usage, this.tools] = await Promise.all([this.api.cacheUsage(), this.api.mediaTools().catch(() => null)]);
      this.render();
    } catch (err) {
      this.onError(err);
    }
  }

  async update(patch) {
    try {
      this.fieldErrors.clear();
      this.view = await this.api.updateSettings(patch);
      this.onChanged(this.view);
      if (patch.advanced && 'ffmpegDir' in patch.advanced) {
        this.tools = null;
        this.render();
        this.tools = await this.api.mediaTools().catch(() => null);
      }
    } catch (err) {
      if (Array.isArray(err.fieldErrors)) for (const fe of err.fieldErrors) this.fieldErrors.set(fe.field, fe.message);
      else this.onError(err);
    }
    this.render();
  }

  render() {
    if (!this.view) return replace(this.root, h('section.page', null, h('h2', null, 'Settings'), h('p.empty', null, 'Loading…')));
    const s = this.view.settings;
    const err = (field) => (this.fieldErrors.has(field) ? h('span.error', null, this.fieldErrors.get(field)) : null);

    const toggle = (field, label, help, value, onchange) =>
      h(
        'div.field',
        null,
        h('span.label', null, label),
        help ? h('span.help', null, help) : null,
        h('span.control', null, h('label.toggle', null, h('input', { type: 'checkbox', checked: value, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }), h('span.track'))),
        err(field),
      );
    const number = (field, label, help, value, { min, max, step = 1, unit = '', blankMeans = null, onchange }) => {
      const input = h('input', {
        type: 'number',
        min,
        max,
        step,
        value: value === null ? '' : String(value),
        placeholder: blankMeans ?? '',
        'aria-label': label,
        onchange: (e) => {
          const raw = e.target.value.trim();
          if (raw === '' && blankMeans !== null) return onchange(null);
          const n = Number(raw);
          if (Number.isFinite(n)) onchange(n);
        },
      });
      return h('div.field', null, h('span.label', null, label), help ? h('span.help', null, help) : null, h('span.control', null, input, unit ? h('span.muted', null, unit) : null), err(field));
    };
    const select = (field, label, help, value, options, onchange) =>
      h(
        'div.field',
        null,
        h('span.label', null, label),
        help ? h('span.help', null, help) : null,
        h(
          'span.control',
          null,
          h(
            'select',
            { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
            options.map(([v, text]) => h('option', { value: v, selected: String(value) === v }, text)),
          ),
        ),
        err(field),
      );
    const section = (title, ...children) => h('section.settings-section', null, h('h3', null, title), children);

    const warnings = this.view.warnings.length > 0 ? h('div.notice', null, this.view.warnings.map((w) => h('div', null, w))) : null;
    const restart = this.view.restartRequired.length > 0 ? h('div.notice', null, 'Some changes apply after Torflix restarts: ', this.view.restartRequired.join(', ')) : null;
    const usage = this.usage;

    replace(
      this.root,
      h(
        'section.page.settings-page',
        { 'aria-labelledby': 'settings-heading' },
        h('h2#settings-heading', { tabindex: '-1' }, 'Settings'),
        warnings,
        restart,
        section(
          'Playback',
          select('playback.defaultSpeed', 'Default speed', 'Speed new videos start at.', s.playback.defaultSpeed, [['0.75', '0.75×'], ['1', '1×'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['1.75', '1.75×'], ['2', '2×'], ['2.5', '2.5×'], ['3', '3×']], (v) => this.update({ playback: { defaultSpeed: Number(v) } })),
          toggle('playback.resumePosition', 'Resume where you left off', 'Reopening an unfinished video offers to continue from its last position.', s.playback.resumePosition, (v) => this.update({ playback: { resumePosition: v } })),
          toggle('playback.subtitlesByDefault', 'Subtitles on by default', 'Turn on subtitles in your language when a video has them.', s.playback.subtitlesByDefault, (v) => this.update({ playback: { subtitlesByDefault: v } })),
          toggle(
            'playback.warmUp',
            'Get ready to play when a title opens',
            'A title page joins its first choice’s swarm and fetches its first few MB, so Play starts in about a second. Nothing is uploaded until it plays, and it is deleted if it does not.',
            s.playback.warmUp,
            (v) => this.update({ playback: { warmUp: v } }),
          ),
          toggle('playback.switchDeadCopies', 'Switch to another copy when one sends nothing', 'If a torrent sends no data within 20 seconds of Play, the next copy of the same film or episode plays instead. A toast offers to go back.', s.playback.switchDeadCopies, (v) => this.update({ playback: { switchDeadCopies: v } })),
        ),
        section(
          'Storage',
          h(
            'div.field.block.desktop-only',
            null,
            h('span.label', null, 'Download folder'),
            h('span.help', null, 'Where videos are stored while they play and after. A change applies after a restart.'),
            h(
              'span.control',
              null,
              h('span.path', null, s.storage.downloadDir ?? this.view.defaultDownloadDir),
              h(
                'button.btn.secondary.small',
                {
                  type: 'button',
                  onclick: async () => {
                    const dir = await this.api.chooseDownloadDir().catch(this.onError);
                    if (dir) this.update({ storage: { downloadDir: dir } });
                  },
                },
                'Choose…',
              ),
              s.storage.downloadDir ? h('button.btn.secondary.small', { type: 'button', onclick: () => this.update({ storage: { downloadDir: null } }) }, 'Use default') : null,
              h('button.btn.secondary.small', { type: 'button', onclick: () => this.api.openDownloadDir().catch(this.onError) }, 'Show folder'),
            ),
            err('storage.downloadDir'),
          ),
          number('storage.cacheLimitGb', 'Cache size limit', 'Oldest finished, unqueued downloads are removed when the folder grows past this.', s.storage.cacheLimitGb, { min: 1, max: 100000, unit: 'GB', blankMeans: 'unlimited', onchange: (v) => this.update({ storage: { cacheLimitGb: v } }) }),
          number('storage.cleanupAfterDays', 'Remove downloads after', 'Finished, unqueued downloads older than this are removed.', s.storage.cleanupAfterDays, { min: 1, max: 3650, unit: 'days', blankMeans: 'never', onchange: (v) => this.update({ storage: { cleanupAfterDays: v } }) }),
          h(
            'div.field',
            null,
            h('span.label', null, 'Space used'),
            h('span.help', null, usage ? `${formatBytes(usage.bytes)} in ${usage.files} files${usage.complete ? '' : ' (at least)'} · ${formatBytes(usage.reclaimableBytes)} in ${usage.reclaimableDownloads} finished, unqueued downloads can be cleared.` : 'Measuring…'),
            h(
              'span.control',
              null,
              h(
                'button.btn.secondary.small',
                {
                  type: 'button',
                  disabled: !usage || usage.reclaimableDownloads === 0,
                  onclick: async () => {
                    const r = await this.api.clearCache().catch(this.onError);
                    if (r) this.onChanged(this.view, `Cleared ${formatBytes(r.removedBytes)} in ${r.removedDownloads} downloads.`);
                    this.usage = await this.api.cacheUsage().catch(() => null);
                    this.render();
                  },
                },
                'Clear now',
              ),
            ),
          ),
        ),
        section(
          'Bandwidth and seeding',
          number('bandwidth.downloadLimitKib', 'Download limit', 'For every torrent together; 0 means unlimited.', s.bandwidth.downloadLimitKib, { min: 0, max: 1048576, unit: 'KiB/s', onchange: (v) => this.update({ bandwidth: { downloadLimitKib: v } }) }),
          number('bandwidth.uploadLimitKib', 'Upload limit', 'For every torrent together; 0 means unlimited.', s.bandwidth.uploadLimitKib, { min: 0, max: 1048576, unit: 'KiB/s', onchange: (v) => this.update({ bandwidth: { uploadLimitKib: v } }) }),
          toggle('bandwidth.backgroundDownloads', 'Download the whole video', 'Off: only what the player needs next downloads. On: the rest of the video playing downloads too, so skipping ahead is instant, using your connection meanwhile.', s.bandwidth.backgroundDownloads, (v) => this.update({ bandwidth: { backgroundDownloads: v } })),
          number('bandwidth.peerLimit', 'Peers', 'Most connected peers at once.', s.bandwidth.peerLimit, { min: 5, max: 500, onchange: (v) => this.update({ bandwidth: { peerLimit: v } }) }),
          toggle('bandwidth.seedAfterWatching', 'Keep sharing after watching', 'Off: a torrent stops uploading as soon as nothing is playing it. On: keep uploading to other peers after watching, until the targets below.', s.bandwidth.seedAfterWatching, (v) => this.update({ bandwidth: { seedAfterWatching: v } })),
          number('bandwidth.seedRatioTarget', 'Stop at ratio', 'Uploaded ÷ downloaded; 0 keeps sharing while Torflix runs.', s.bandwidth.seedRatioTarget, { min: 0, max: 100, step: 0.5, onchange: (v) => this.update({ bandwidth: { seedRatioTarget: v } }) }),
          number('bandwidth.seedTimeLimitMinutes', 'Stop after', 'Minutes of sharing after a download finished; 0 for no time limit.', s.bandwidth.seedTimeLimitMinutes, { min: 0, max: 525600, unit: 'min', onchange: (v) => this.update({ bandwidth: { seedTimeLimitMinutes: v } }) }),
        ),
        section(
          'Search',
          h('p.help', { style: { margin: '0 0 0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' } }, 'Searches go to the public index at search.emberglow.tech, which sees your search terms. Pasting a magnet link needs nothing but the swarm.'),
          toggle('search.hideAdult', 'Hide adult categories', null, s.search.hideAdult, (v) => this.update({ search: { hideAdult: v } })),
          toggle('search.preloadTopResult', 'Preload the best pick', 'Fetch the start of the best search result, and of the title opened on Browse, so Play starts at once. Uses your connection for videos you may not watch; never uploaded, deleted if unused.', s.search.preloadTopResult, (v) => this.update({ search: { preloadTopResult: v } })),
          toggle('search.prefetchResults', 'Fetch details and pictures from results', 'Joins the swarms of the results on screen for their file lists and a picture from inside each torrent. Posters from TVmaze and Wikipedia show either way.', s.search.prefetchResults, (v) => this.update({ search: { prefetchResults: v } })),
          number('search.resultsPerSearch', 'Results per search', null, s.search.resultsPerSearch, { min: 10, max: 500, onchange: (v) => this.update({ search: { resultsPerSearch: v } }) }),
        ),
        section(
          'Network',
          h(
            'div.notice',
            null,
            'This build connects directly. Keep a VPN app connected at the system level if you want your address hidden from peers; the built-in WireGuard tunnel and SOCKS5 modes of the original app are not part of this Electron rebuild.',
          ),
          toggle('network.incomingPeers.enabled', 'Incoming peer connections', 'Listen on a fixed port for more peers and better uploads. Applies after a restart.', s.network.incomingPeers.enabled, (v) => this.update({ network: { incomingPeers: { enabled: v } } })),
          number('network.incomingPeers.port', 'Port', '1024–65535, or 0 for a random port each run.', s.network.incomingPeers.port, { min: 0, max: 65535, onchange: (v) => this.update({ network: { incomingPeers: { port: v } } }) }),
          toggle('network.incomingPeers.upnp', 'Map the port with UPnP / NAT-PMP', 'Ask the router to forward the port.', s.network.incomingPeers.upnp, (v) => this.update({ network: { incomingPeers: { upnp: v } } })),
        ),
        section(
          'Browse',
          h('p.help', { style: { margin: '0 0 0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' } }, 'Browse ranks films and series by their seeders on the public index. Posters and information come from Wikipedia and Wikidata (films) and TVmaze (series), which see the titles asked for; none needs a key or an account.'),
          toggle('browse.enabled', 'Browse page', 'Read the index for the best-seeded films and series.', s.browse.enabled, (v) => this.update({ browse: { enabled: v } })),
          toggle('browse.fetchInfo', 'Posters and information', 'Look up the titles on Browse and in search results.', s.browse.fetchInfo, (v) => this.update({ browse: { fetchInfo: v } })),
          toggle(
            'browse.metaService',
            'Through the Torflix metadata service',
            'Faster, and kind to the sources: every Torflix user shares one cached answer per title. The service (torflix-meta.vercel.app, open source, keeps no logs of its own) sees the titles asked for. Off: Torflix asks the sources itself.',
            Boolean(s.browse.metaService),
            (v) => this.update({ browse: { metaService: v ? DEFAULT_META_SERVICE : '' } }),
          ),
          h(
            'div.field',
            null,
            h('span.label', null, 'Country'),
            h('span.help', null, 'For today’s streaming and TV schedules (two-letter code).'),
            h(
              'span.control',
              null,
              h('input', {
                type: 'text',
                value: s.browse.region,
                maxlength: '2',
                style: { width: '4.5rem', textTransform: 'uppercase' },
                'aria-label': 'Country',
                onchange: (e) => this.update({ browse: { region: e.target.value.trim().toUpperCase() } }),
              }),
            ),
            err('browse.region'),
          ),
        ),
        section(
          'Advanced',
          h(
            'div.field.block.desktop-only',
            null,
            h('span.label', null, 'FFmpeg (for Dolby and DTS audio)'),
            h(
              'span.help',
              null,
              'Many releases carry Dolby Digital, Dolby Digital Plus, TrueHD or DTS audio, which the built-in player cannot decode. With FFmpeg, Torflix converts that audio as the video plays; without it those videos are silent. Optional; Torflix never downloads it. ',
              this.tools === undefined || this.tools === null
                ? 'Looking for FFmpeg…'
                : this.tools.ffmpeg && this.tools.ffprobe
                  ? `Found${this.tools.version ? ` (version ${this.tools.version})` : ''}: ${this.tools.ffmpeg}`
                  : this.tools.ffmpeg
                    ? 'FFmpeg found, but not ffprobe next to it.'
                    : 'Not found. Install it (for example: winget install Gyan.FFmpeg) or choose its folder.',
            ),
            h(
              'span.control',
              null,
              s.advanced.ffmpegDir ? h('span.path', null, s.advanced.ffmpegDir) : h('span.muted', { style: { fontSize: '0.85rem' } }, 'Looking on PATH'),
              h(
                'button.btn.secondary.small',
                {
                  type: 'button',
                  onclick: async () => {
                    const dir = await this.api.chooseFfmpegDir().catch(this.onError);
                    if (dir) this.update({ advanced: { ffmpegDir: dir } });
                  },
                },
                'Choose folder…',
              ),
              s.advanced.ffmpegDir ? h('button.btn.secondary.small', { type: 'button', onclick: () => this.update({ advanced: { ffmpegDir: null } }) }, 'Use PATH') : null,
            ),
            err('advanced.ffmpegDir'),
          ),
          toggle('advanced.debugOverlay', 'Debug overlay', 'Allow the D key to show live download details and a piece map over the video.', s.advanced.debugOverlay, (v) => this.update({ advanced: { debugOverlay: v } })),
        ),
        section(
          'About',
          h(
            'div.about',
            null,
            h(
              'dl',
              null,
              h('dt', null, 'Torflix'),
              h('dd', null, `${this.info?.version ?? ''} (Electron)`),
              h('dt', null, 'License'),
              h('dd', null, 'MIT OR Apache-2.0'),
              h('dt', null, 'Engine'),
              h('dd', null, 'WebTorrent'),
              h('dt', null, 'Runtime'),
              h('dd', null, this.info ? `Electron ${this.info.electron} · Chromium ${this.info.chrome} · Node ${this.info.node}` : ''),
              h('dt', null, 'Telemetry'),
              h('dd', null, 'none'),
            ),
          ),
        ),
      ),
    );
  }
}

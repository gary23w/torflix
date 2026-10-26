// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Share to TVs: a UPnP/DLNA media server on the local network, so VLC on an Apple TV (or any
// UPnP player) finds "Torflix on <device>" and plays from it. It announces itself over SSDP,
// answers ContentDirectory Browse with folders (Continue watching, Recently played, Playing
// now, and the Browse rows: films to play, series by season and episode), and serves a video by
// starting its stream here and relaying the stream server's bytes, ranges and all. One video
// plays at a time, as in the app. Off unless turned on in Settings, and only addresses on this
// device's own networks are answered.

import { EventEmitter } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { mimeOf } from '../shared/files.js';
import { parseRelease } from '../shared/release.js';
import { episodeLabel } from '../shared/episodes.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MAX_AGE_SECS = 1800;
const ANNOUNCE_EVERY_MS = 10 * 60 * 1000;
/** A fixed port, so a player's saved favourite keeps working; another is used if it is taken. */
const PREFERRED_PORT = 8327;
/** A stream no player has read for this long is closed, so it stops downloading. */
const IDLE_STOP_MS = 10 * 60 * 1000;
/** How long a folder listing waits for Browse's rows while they are being read from the index. */
const ROWS_WAIT_MS = 8000;
const SERIES_TTL_MS = 10 * 60 * 1000;
const MAX_LIBRARY_ITEMS = 200;
const MAX_BODY = 64 * 1024;

export const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
export const CDS = 'urn:schemas-upnp-org:service:ContentDirectory:1';
export const CMS = 'urn:schemas-upnp-org:service:ConnectionManager:1';
/** Range requests allowed (OP=01), streaming transfer: what DLNA players check before seeking. */
const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const VIDEO_TYPES = ['video/x-matroska', 'video/mp4', 'video/webm', 'video/x-msvideo', 'video/quicktime', 'video/mp2t'];

// ----- XML and SOAP -----

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Text for XML: escaped, without the control characters XML 1.0 forbids. */
export function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function unxml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/** An argument of a SOAP request body, or null. */
export function soapArg(body, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(body);
  if (m) return unxml(m[1].trim());
  return new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?/>`).test(body) ? '' : null;
}

/** A Browse request's arguments. */
export function browseArgs(body) {
  const int = (v, fallback) => (/^\d{1,9}$/.test(v ?? '') ? Number(v) : fallback);
  return {
    objectId: soapArg(body, 'ObjectID') ?? '0',
    flag: soapArg(body, 'BrowseFlag') ?? 'BrowseDirectChildren',
    start: int(soapArg(body, 'StartingIndex'), 0),
    count: int(soapArg(body, 'RequestedCount'), 0),
  };
}

function envelope(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
}

export function soapResponse(service, action, fields) {
  const args = Object.entries(fields)
    .map(([k, v]) => `<${k}>${xml(v)}</${k}>`)
    .join('');
  return envelope(`<u:${action}Response xmlns:u="${service}">${args}</u:${action}Response>`);
}

export function soapFault(code, description) {
  return envelope(
    `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${xml(description)}</errorDescription></UPnPError></detail></s:Fault>`,
  );
}

class UpnpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ----- The folder tree -----

/** An object's parent: ids are paths (`row:top-series/s:<key>/n:2/e:3`), so it is the path's head. */
export function parentOf(id) {
  if (id === '0') return '-1';
  const at = id.lastIndexOf('/');
  return at < 0 ? '0' : id.slice(0, at);
}

/**
 * DIDL-Lite for folders (`folder: true`) and videos (`url` set): what a Browse answer carries.
 * Posters go in albumArtURI, so VLC shows them on its folder and video tiles.
 */
export function didl(objects) {
  const body = objects
    .map((o) => {
      const common =
        `<dc:title>${xml(o.title)}</dc:title>` +
        (o.art ? `<upnp:albumArtURI>${xml(o.art)}</upnp:albumArtURI>` : '') +
        (o.description ? `<dc:description>${xml(o.description)}</dc:description>` : '');
      const ids = `id="${xml(o.id)}" parentID="${xml(parentOf(o.id))}" restricted="1"`;
      if (o.folder) {
        const count = Number.isInteger(o.childCount) ? ` childCount="${o.childCount}"` : '';
        return `<container ${ids} searchable="0"${count}>${common}<upnp:class>object.container.storageFolder</upnp:class></container>`;
      }
      const size = Number.isFinite(o.size) && o.size > 0 ? ` size="${Math.round(o.size)}"` : '';
      return `<item ${ids}>${common}<upnp:class>${o.movie ? 'object.item.videoItem.movie' : 'object.item.videoItem'}</upnp:class><res protocolInfo="http-get:*:${o.mime ?? 'video/x-matroska'}:${DLNA_FEATURES}"${size}>${xml(o.url)}</res></item>`;
    })
    .join('');
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${body}</DIDL-Lite>`;
}

/**
 * A library file's name as a TV shows it: "Title (2024)", "Title S1 E3", else the file's name.
 * A file name that says nothing ("_unpack.mkv") gives way to its torrent's, as title pages do.
 */
export function displayName(fileTitle, torrentName = null) {
  for (const name of [fileTitle, torrentName]) {
    const p = parseRelease(name);
    if (p?.kind === 'tv' && p.season !== null && p.episode !== null) return `${p.title} ${episodeLabel(p.season, p.episode)}`;
    if (p && p.kind !== 'tv' && p.year) return `${p.title} (${p.year})`;
  }
  return String(fileTitle ?? '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

/** A torrent's video type, as far as its name tells (Matroska unless it says MP4). */
const mimeOfRelease = (name) => (/\bmp4\b|\.mp4$/i.test(name ?? '') ? 'video/mp4' : 'video/x-matroska');

// ----- SSDP -----

/** The (ST, USN) pairs that answer an M-SEARCH for `st`. */
export function searchTargets(st, uuid) {
  const all = [
    ['upnp:rootdevice', `uuid:${uuid}::upnp:rootdevice`],
    [`uuid:${uuid}`, `uuid:${uuid}`],
    [DEVICE_TYPE, `uuid:${uuid}::${DEVICE_TYPE}`],
    [CDS, `uuid:${uuid}::${CDS}`],
    [CMS, `uuid:${uuid}::${CMS}`],
  ];
  return st === 'ssdp:all' ? all : all.filter(([t]) => t === st);
}

/** An SSDP message's start line and headers (names in lower case). */
export function parseSsdp(text) {
  const [start, ...lines] = String(text).split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { start: start.trim(), headers };
}

export function ssdpReply({ st, usn, location, server, date = new Date() }) {
  return ['HTTP/1.1 200 OK', `CACHE-CONTROL: max-age=${MAX_AGE_SECS}`, `DATE: ${date.toUTCString()}`, 'EXT:', `LOCATION: ${location}`, `SERVER: ${server}`, `ST: ${st}`, `USN: ${usn}`, '', ''].join('\r\n');
}

export function ssdpNotify({ nt, usn, location, server, alive }) {
  const lines = ['NOTIFY * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, `NT: ${nt}`, `NTS: ${alive ? 'ssdp:alive' : 'ssdp:byebye'}`, `USN: ${usn}`];
  if (alive) lines.push(`CACHE-CONTROL: max-age=${MAX_AGE_SECS}`, `LOCATION: ${location}`, `SERVER: ${server}`);
  return [...lines, '', ''].join('\r\n');
}

// ----- Networks -----

const ipv4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
const toInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
/** A peer's address without the IPv6 prefix Node gives IPv4 peers on dual-stack sockets. */
export const plainAddress = (address) => String(address ?? '').replace(/^::ffff:/i, '');

/** This device's IPv4 networks, `{ address, netmask }`, loopback left out. */
export function lanNetworks(interfaces) {
  return Object.values(interfaces ?? {})
    .flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && ipv4(a.address) && ipv4(a.netmask))
    .map((a) => ({ address: a.address, netmask: a.netmask }));
}

/** The network `remote` is on, among `networks`, or null. */
export function networkOf(remote, networks) {
  const ip = plainAddress(remote);
  if (!ipv4(ip)) return null;
  const n = toInt(ip);
  return (
    networks.find((net) => {
      // A contiguous mask's network is a block of 2^32 - mask addresses.
      const block = 2 ** 32 - toInt(net.netmask);
      return Math.floor(n / block) === Math.floor(toInt(net.address) / block);
    }) ?? null
  );
}

const isLoopback = (remote) => /^127\./.test(plainAddress(remote)) || remote === '::1';

/**
 * The networks to share on. Android 11 and later refuse the interface list to apps, so then
 * the address the system would send to the SSDP group from stands in, as a /16.
 */
async function currentNetworks() {
  try {
    const list = lanNetworks(os.networkInterfaces());
    if (list.length > 0) return list;
  } catch {
    // refused: below
  }
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => {
      s.close();
      resolve([]);
    });
    s.connect(SSDP_PORT, SSDP_ADDRESS, () => {
      const address = s.address().address;
      s.close();
      resolve(ipv4(address) && address !== '0.0.0.0' ? [{ address, netmask: '255.255.0.0' }] : []);
    });
  });
}

// ----- Descriptions -----

function deviceDescription({ uuid, name, version, icon }) {
  const icons = icon ? `<iconList><icon><mimetype>image/png</mimetype><width>${icon.width}</width><height>${icon.height}</height><depth>24</depth><url>/icon.png</url></icon></iconList>` : '';
  const service = (type, id, base) => `<service><serviceType>${type}</serviceType><serviceId>urn:upnp-org:serviceId:${id}</serviceId><SCPDURL>/${base}.xml</SCPDURL><controlURL>/${base}/control</controlURL><eventSubURL>/${base}/event</eventSubURL></service>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>${DEVICE_TYPE}</deviceType><friendlyName>${xml(name)}</friendlyName><manufacturer>Torflix</manufacturer><manufacturerURL>https://github.com/gary23w/torflix</manufacturerURL><modelDescription>Torflix, shared to TVs on this network</modelDescription><modelName>Torflix</modelName><modelNumber>${xml(version)}</modelNumber><modelURL>https://github.com/gary23w/torflix</modelURL><UDN>uuid:${uuid}</UDN><dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>${icons}<serviceList>${service(CDS, 'ContentDirectory', 'ContentDirectory')}${service(CMS, 'ConnectionManager', 'ConnectionManager')}</serviceList></device></root>`;
}

function scpd(actions, variables) {
  const arg = ([name, direction, variable]) => `<argument><name>${name}</name><direction>${direction}</direction><relatedStateVariable>${variable}</relatedStateVariable></argument>`;
  const action = ([name, args]) => `<action><name>${name}</name><argumentList>${args.map(arg).join('')}</argumentList></action>`;
  const variable = ([name, type, events = 'no', values = null]) =>
    `<stateVariable sendEvents="${events}"><name>${name}</name><dataType>${type}</dataType>${values ? `<allowedValueList>${values.map((v) => `<allowedValue>${v}</allowedValue>`).join('')}</allowedValueList>` : ''}</stateVariable>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions.map(action).join('')}</actionList><serviceStateTable>${variables.map(variable).join('')}</serviceStateTable></scpd>`;
}

const CDS_SCPD = scpd(
  [
    [
      'Browse',
      [
        ['ObjectID', 'in', 'A_ARG_TYPE_ObjectID'],
        ['BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'],
        ['Filter', 'in', 'A_ARG_TYPE_Filter'],
        ['StartingIndex', 'in', 'A_ARG_TYPE_Index'],
        ['RequestedCount', 'in', 'A_ARG_TYPE_Count'],
        ['SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'],
        ['Result', 'out', 'A_ARG_TYPE_Result'],
        ['NumberReturned', 'out', 'A_ARG_TYPE_Count'],
        ['TotalMatches', 'out', 'A_ARG_TYPE_Count'],
        ['UpdateID', 'out', 'A_ARG_TYPE_UpdateID'],
      ],
    ],
    ['GetSearchCapabilities', [['SearchCaps', 'out', 'SearchCapabilities']]],
    ['GetSortCapabilities', [['SortCaps', 'out', 'SortCapabilities']]],
    ['GetSystemUpdateID', [['Id', 'out', 'SystemUpdateID']]],
  ],
  [
    ['A_ARG_TYPE_ObjectID', 'string'],
    ['A_ARG_TYPE_BrowseFlag', 'string', 'no', ['BrowseMetadata', 'BrowseDirectChildren']],
    ['A_ARG_TYPE_Filter', 'string'],
    ['A_ARG_TYPE_Index', 'ui4'],
    ['A_ARG_TYPE_Count', 'ui4'],
    ['A_ARG_TYPE_SortCriteria', 'string'],
    ['A_ARG_TYPE_Result', 'string'],
    ['A_ARG_TYPE_UpdateID', 'ui4'],
    ['SearchCapabilities', 'string'],
    ['SortCapabilities', 'string'],
    ['SystemUpdateID', 'ui4', 'yes'],
  ],
);

const CMS_SCPD = scpd(
  [
    [
      'GetProtocolInfo',
      [
        ['Source', 'out', 'SourceProtocolInfo'],
        ['Sink', 'out', 'SinkProtocolInfo'],
      ],
    ],
    ['GetCurrentConnectionIDs', [['ConnectionIDs', 'out', 'CurrentConnectionIDs']]],
    [
      'GetCurrentConnectionInfo',
      [
        ['ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'],
        ['RcsID', 'out', 'A_ARG_TYPE_RcsID'],
        ['AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'],
        ['ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'],
        ['PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'],
        ['PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'],
        ['Direction', 'out', 'A_ARG_TYPE_Direction'],
        ['Status', 'out', 'A_ARG_TYPE_ConnectionStatus'],
      ],
    ],
  ],
  [
    ['SourceProtocolInfo', 'string', 'yes'],
    ['SinkProtocolInfo', 'string', 'yes'],
    ['CurrentConnectionIDs', 'string', 'yes'],
    ['A_ARG_TYPE_ConnectionStatus', 'string', 'no', ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth', 'UnreliableChannel', 'Unknown']],
    ['A_ARG_TYPE_ConnectionManager', 'string'],
    ['A_ARG_TYPE_Direction', 'string', 'no', ['Input', 'Output']],
    ['A_ARG_TYPE_ProtocolInfo', 'string'],
    ['A_ARG_TYPE_ConnectionID', 'i4'],
    ['A_ARG_TYPE_AVTransportID', 'i4'],
    ['A_ARG_TYPE_RcsID', 'i4'],
  ],
);

// ----- The server -----

export class ShareServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir where the server's lasting identity is kept
   * @param {string} [opts.deviceName] the name players show after "Torflix on"
   * @param {string} [opts.iconPath] a PNG for players' server lists
   * @param {(on: boolean) => void} [opts.onMulticast] the platform must let multicast in (Android Wi-Fi)
   */
  constructor({ dataDir, settings, library, browse, titles, streams, version = '0', deviceName = null, iconPath = null, onMulticast = null }) {
    super();
    Object.assign(this, { dataDir, settings, library, browse, titles, streams, version, iconPath, onMulticast });
    this.name = `Torflix on ${String(deviceName || os.hostname() || 'this device').slice(0, 60)}`;
    this.serverHeader = `${os.type()}/${os.release()} UPnP/1.0 Torflix/${version}`;
    this.http = null;
    this.udp = null;
    this.sockets = new Set();
    this.networks = [];
    this.joined = new Set();
    this.port = 0;
    this.uuid = null;
    this.icon = null;
    this.error = null;
    this.timer = null;
    /** Bumped when what the folders hold changes, so players that cache them look again. */
    this.updateId = 1;
    /** The video this server started: `{ id, streamId, url, name }`. */
    this.current = null;
    this.opening = new Map();
    this.relays = 0;
    this.idleTimer = null;
    this.seriesCache = new Map();
    /** Starts and stops run one after the other. */
    this.pending = Promise.resolve();
    library.on?.('library-changed', () => (this.updateId += 1));
    browse.on?.('rows', () => (this.updateId += 1));
  }

  get enabled() {
    return this.settings.settings.network.shareOnLan === true;
  }

  /** Starts or stops to match Settings. */
  apply() {
    const want = this.enabled;
    this.pending = this.pending.then(() => (want ? this.#start() : this.#stop())).catch((err) => {
      this.error = err?.message ?? String(err);
      console.error('[share]', this.error);
    });
    return this.pending;
  }

  /** What the Settings page shows. */
  async status() {
    await this.pending;
    return {
      enabled: this.enabled,
      running: Boolean(this.http),
      name: this.name,
      port: this.port,
      addresses: this.networks.map((n) => n.address),
      error: this.error,
    };
  }

  async #start() {
    if (this.http) return;
    this.error = null;
    this.uuid ??= await this.#identity();
    this.icon ??= await this.#loadIcon();
    this.networks = await currentNetworks();
    await this.#listen();
    try {
      await this.#ssdp();
    } catch (err) {
      // The folders still work for a player told the address; finding them needs SSDP.
      this.error =
        err?.code === 'EADDRINUSE' || err?.code === 'EACCES'
          ? 'Another program holds the port players search on (UDP 1900), so they cannot find Torflix by themselves.'
          : `Players cannot find Torflix by themselves: ${err?.message ?? err}`;
      console.error(`[share] SSDP: ${err?.message ?? err}`);
    }
    if (this.networks.length === 0) this.error ??= 'This device is not on a network.';
    this.onMulticast?.(true);
    this.#announce(true);
    // Sent twice: the first datagram on a Wi-Fi network is easily lost.
    setTimeout(() => this.udp && this.#announce(true), 1500).unref?.();
    this.timer = setInterval(() => this.#refresh(), ANNOUNCE_EVERY_MS);
    this.timer.unref?.();
    console.log(`[share] "${this.name}" on ${this.networks.map((n) => `${n.address}:${this.port}`).join(', ') || 'no network'}`);
    this.emit('status');
  }

  async #stop() {
    if (!this.http && !this.udp) return;
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.idleTimer);
    if (this.udp) {
      this.#announce(false);
      // The goodbyes go out before the socket closes.
      await new Promise((r) => setTimeout(r, 100));
      try {
        this.udp.close();
      } catch {
        // closed already
      }
      this.udp = null;
      this.joined.clear();
    }
    if (this.current) this.streams.stop(this.current.streamId, 'request');
    this.current = null;
    const server = this.http;
    this.http = null;
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => server.close(() => r()));
    this.port = 0;
    this.onMulticast?.(false);
    this.emit('status');
  }

  /** Stops for good (quitting): says goodbye on the network. */
  close() {
    this.pending = this.pending.then(() => this.#stop()).catch(() => {});
    return this.pending;
  }

  async #identity() {
    const file = path.join(this.dataDir, 'share.json');
    try {
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (/^[0-9a-f-]{36}$/.test(saved?.uuid ?? '')) return saved.uuid;
    } catch {
      // none yet
    }
    const uuid = crypto.randomUUID();
    await fsp.writeFile(file, JSON.stringify({ uuid })).catch(() => {});
    return uuid;
  }

  async #loadIcon() {
    if (!this.iconPath) return null;
    try {
      const bytes = await fsp.readFile(this.iconPath);
      if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    } catch {
      return null;
    }
  }

  #listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.#handle(req, res).catch((err) => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          } else res.destroy();
          console.error('[share] request failed:', err?.message ?? err);
        });
      });
      server.keepAliveTimeout = 65_000;
      server.on('clientError', (_err, socket) => socket.destroy());
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      const attempt = (port) => {
        server.once('error', (err) => {
          if (port !== 0 && err.code === 'EADDRINUSE') return attempt(0);
          reject(err);
        });
        server.listen(port, '0.0.0.0', () => {
          this.http = server;
          this.port = server.address().port;
          resolve();
        });
      };
      attempt(PREFERRED_PORT);
    });
  }

  #ssdp() {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udp.once('error', reject);
      udp.on('message', (msg, rinfo) => this.#onSsdp(msg, rinfo));
      udp.bind(SSDP_PORT, () => {
        udp.removeListener('error', reject);
        udp.on('error', (err) => console.error(`[share] SSDP: ${err?.message ?? err}`));
        udp.setMulticastTTL(4);
        this.udp = udp;
        this.#join();
        resolve();
      });
    });
  }

  #join() {
    for (const net of this.networks) {
      if (this.joined.has(net.address)) continue;
      try {
        this.udp.addMembership(SSDP_ADDRESS, net.address);
        this.joined.add(net.address);
      } catch (err) {
        console.error(`[share] cannot listen for players on ${net.address}: ${err?.message ?? err}`);
      }
    }
  }

  /** Networks come and go (Wi-Fi reconnects): looks again, then announces itself again. */
  async #refresh() {
    if (!this.http) return;
    this.networks = await currentNetworks();
    if (this.udp) this.#join();
    this.#announce(true);
  }

  #location(address) {
    return `http://${address}:${this.port}/description.xml`;
  }

  #announce(alive) {
    if (!this.udp) return;
    for (const net of this.networks) {
      try {
        this.udp.setMulticastInterface(net.address);
      } catch {
        continue;
      }
      for (const [nt, usn] of searchTargets('ssdp:all', this.uuid)) {
        const text = ssdpNotify({ nt, usn, location: this.#location(net.address), server: this.serverHeader, alive });
        this.udp.send(text, SSDP_PORT, SSDP_ADDRESS, () => {});
      }
    }
  }

  #onSsdp(msg, rinfo) {
    const { start, headers } = parseSsdp(msg.toString('latin1'));
    if (!/^M-SEARCH \* HTTP\/1\.1$/i.test(start) || headers.man?.replace(/"/g, '') !== 'ssdp:discover') return;
    const net = networkOf(rinfo.address, this.networks);
    const targets = searchTargets(headers.st, this.uuid);
    if (!net || targets.length === 0) return;
    // Answers are spread over the wait the search allows (MX), as SSDP asks, up to a second.
    const wait = Math.min(Math.max(Number(headers.mx) || 1, 1), 5);
    setTimeout(() => {
      if (!this.udp) return;
      for (const [st, usn] of targets) {
        this.udp.send(ssdpReply({ st, usn, location: this.#location(net.address), server: this.serverHeader }), rinfo.port, rinfo.address, () => {});
      }
    }, Math.random() * Math.min(wait, 1) * 1000).unref?.();
  }

  async #handle(req, res) {
    const remote = req.socket.remoteAddress;
    if (!isLoopback(remote) && !networkOf(remote, this.networks)) return end(res, 403);
    res.setHeader('Server', this.serverHeader);
    const url = new URL(req.url, 'http://share.invalid');
    const route = url.pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (route === '/description.xml') return sendXml(res, req, deviceDescription({ uuid: this.uuid, name: this.name, version: this.version, icon: this.icon }));
      if (route === '/ContentDirectory.xml') return sendXml(res, req, CDS_SCPD);
      if (route === '/ConnectionManager.xml') return sendXml(res, req, CMS_SCPD);
      if (route === '/icon.png' && this.icon) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': this.icon.bytes.length });
        return res.end(req.method === 'HEAD' ? undefined : this.icon.bytes);
      }
      const m = /^\/media\/([^/]+)(?:\/[^/]*)?$/.exec(route);
      if (m) return this.#media(req, res, decodeURIComponent(m[1]));
      return end(res, 404);
    }
    if (req.method === 'POST' && (route === '/ContentDirectory/control' || route === '/ConnectionManager/control')) {
      return this.#control(req, res, route.startsWith('/Content') ? CDS : CMS);
    }
    // Event subscriptions: accepted, so players that ask go on; nothing here changes by itself.
    if ((req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') && route.endsWith('/event')) {
      res.writeHead(200, req.method === 'SUBSCRIBE' ? { SID: req.headers.sid ?? `uuid:${crypto.randomUUID()}`, TIMEOUT: 'Second-1800' } : {});
      return res.end();
    }
    return end(res, 405);
  }

  async #control(req, res, service) {
    const body = await readBody(req);
    const action = /#(\w+)"?\s*$/.exec(req.headers.soapaction ?? '')?.[1] ?? '';
    const reply = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '' });
      res.end(text);
    };
    try {
      if (service === CDS && action === 'Browse') {
        const args = browseArgs(body);
        const { list, total } = await this.#browse(args, hostOf(req, this.networks, this.port));
        return reply(200, soapResponse(CDS, 'Browse', { Result: didl(list), NumberReturned: list.length, TotalMatches: total, UpdateID: this.updateId }));
      }
      if (service === CDS && action === 'GetSystemUpdateID') return reply(200, soapResponse(CDS, action, { Id: this.updateId }));
      if (service === CDS && action === 'GetSearchCapabilities') return reply(200, soapResponse(CDS, action, { SearchCaps: '' }));
      if (service === CDS && action === 'GetSortCapabilities') return reply(200, soapResponse(CDS, action, { SortCaps: '' }));
      if (service === CMS && action === 'GetProtocolInfo') {
        return reply(200, soapResponse(CMS, action, { Source: VIDEO_TYPES.map((t) => `http-get:*:${t}:*`).join(','), Sink: '' }));
      }
      if (service === CMS && action === 'GetCurrentConnectionIDs') return reply(200, soapResponse(CMS, action, { ConnectionIDs: '0' }));
      if (service === CMS && action === 'GetCurrentConnectionInfo') {
        return reply(200, soapResponse(CMS, action, { RcsID: -1, AVTransportID: -1, ProtocolInfo: '', PeerConnectionManager: '', PeerConnectionID: -1, Direction: 'Output', Status: 'OK' }));
      }
      throw new UpnpError(401, 'Invalid Action');
    } catch (err) {
      if (!(err instanceof UpnpError)) console.error('[share] browse failed:', err?.stack ?? err);
      return reply(500, soapFault(err instanceof UpnpError ? err.code : 501, err instanceof UpnpError ? err.message : 'Action Failed'));
    }
  }

  async #browse({ objectId, flag, start, count }, host) {
    if (flag === 'BrowseMetadata') {
      if (objectId === '0') return { list: [{ id: '0', title: this.name, folder: true, childCount: (await this.#children('0', host)).length }], total: 1 };
      const siblings = await this.#children(parentOf(objectId), host);
      const found = siblings?.find((o) => o.id === objectId);
      if (!found) throw new UpnpError(701, 'No such object');
      return { list: [found], total: 1 };
    }
    if (flag !== 'BrowseDirectChildren') throw new UpnpError(402, 'Invalid Args');
    const children = await this.#children(objectId, host);
    if (!children) throw new UpnpError(701, 'No such object');
    return { list: children.slice(start, count > 0 ? start + count : undefined), total: children.length };
  }

  /** A folder's contents, or null when there is no such folder. */
  async #children(id, host) {
    const url = (objectId, name) =>
      `http://${host}/media/${encodeURIComponent(objectId)}/${encodeURIComponent(
        String(name)
          .replace(/[^\p{L}\p{N}._-]+/gu, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 80) || 'video',
      )}`;
    const libraryItem = (parent, it) => {
      const objectId = `${parent}/l:${it.infoHash}:${it.fileIndex}`;
      return { id: objectId, title: displayName(it.title, it.torrentName), url: url(objectId, it.title), size: it.sizeBytes, mime: mimeOf(it.title) };
    };
    if (id === '0') {
      const rows = await this.#rows();
      const resumable = this.#resumable();
      const playing = this.#playing();
      return [
        { id: 'continue', title: 'Continue watching', folder: true, childCount: resumable.length },
        { id: 'recent', title: 'Recently played', folder: true, childCount: Math.min(this.library.list().length, MAX_LIBRARY_ITEMS) },
        ...(playing ? [{ id: 'playing', title: 'Playing now', folder: true, childCount: 1 }] : []),
        ...(rows?.rows ?? []).map((r) => ({ id: `row:${r.id}`, title: r.title, folder: true, childCount: r.items.length })),
      ];
    }
    if (id === 'continue') return this.#resumable().map((it) => libraryItem('continue', it));
    if (id === 'recent') return this.library.list().slice(0, MAX_LIBRARY_ITEMS).map((it) => libraryItem('recent', it));
    if (id === 'playing') {
      const it = this.#playing();
      return it ? [libraryItem('playing', it)] : [];
    }
    const parts = id.split('/');
    if (parts.length === 1 && id.startsWith('row:')) {
      const row = (await this.#rows())?.rows.find((r) => `row:${r.id}` === id);
      if (!row) return null;
      return row.items.flatMap((t) => {
        const name = `${t.meta?.title ?? t.title}${t.year ? ` (${t.year})` : ''}`;
        const look = { art: t.meta?.poster ?? null, description: t.meta?.overview ?? null };
        if (t.kind === 'tv') return [{ id: `${id}/s:${t.key}`, title: t.meta?.title ?? t.title, folder: true, ...look }];
        if (!t.best) return [];
        const objectId = `${id}/t:${t.key}`;
        return [{ id: objectId, title: name, url: url(objectId, name), size: t.best.sizeBytes, mime: mimeOfRelease(t.best.title), movie: true, ...look }];
      });
    }
    const leaf = parts.at(-1);
    if (leaf.startsWith('s:') && parts.length === 2) {
      const series = await this.#series(leaf.slice(2));
      if (!series) return null;
      return [...series.seasons.keys()].map((season) => ({ id: `${id}/n:${season}`, title: `Season ${season}`, folder: true, childCount: series.seasons.get(season).length, art: series.poster }));
    }
    if (leaf.startsWith('n:') && parts.length === 3) {
      const series = await this.#series(parts[1].slice(2));
      const season = Number(leaf.slice(2));
      const episodes = series?.seasons.get(season);
      if (!episodes) return null;
      return episodes.map((ep) => {
        const objectId = `${id}/e:${ep.number}`;
        const title = `${ep.number}. ${ep.name || `Episode ${ep.number}`}`;
        return { id: objectId, title, url: url(objectId, `${series.title} ${episodeLabel(season, ep.number)}`), art: ep.still ?? series.poster, description: ep.summary ?? null };
      });
    }
    return null;
  }

  #resumable() {
    return this.library
      .list()
      .filter((it) => this.library.resumePosition(it.infoHash, it.fileIndex) !== null)
      .slice(0, MAX_LIBRARY_ITEMS);
  }

  /** The library item of the video playing now (in the app or on a TV), if any. */
  #playing() {
    const s = this.streams.active();
    return s ? this.library.get(s.infoHash, s.fileIndex) : null;
  }

  /** Browse's rows, unless Browse is off; waits a little when they are being read. */
  async #rows() {
    if (!this.settings.settings.browse.enabled) return null;
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ROWS_WAIT_MS)));
    try {
      return await Promise.race([this.browse.rows(), late]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A series' seasons and their episodes so far: from TVmaze when it knows the series, else
   * the episodes its known copies name.
   */
  async #series(key) {
    const t = this.browse.titles.get(key);
    if (!t) return null;
    const kept = this.seriesCache.get(key);
    if (kept && Date.now() - kept.at < SERIES_TTL_MS) return kept;
    const { info, episodes } = await this.titles.info({ key, kind: 'tv', title: t.title, year: t.year }).catch(() => ({ info: null, episodes: [] }));
    const today = new Date().toISOString().slice(0, 10);
    let list = episodes.filter((ep) => !ep.airdate || ep.airdate <= today);
    if (list.length === 0) {
      const seen = new Set();
      list = (t.torrents ?? [])
        .filter((x) => Number.isInteger(x.season) && Number.isInteger(x.episode) && !seen.has(`${x.season}:${x.episode}`) && seen.add(`${x.season}:${x.episode}`))
        .map((x) => ({ season: x.season, number: x.episode, name: null, still: null, summary: null }))
        .sort((a, b) => a.season - b.season || a.number - b.number);
    }
    const seasons = new Map();
    for (const ep of list) {
      if (!seasons.has(ep.season)) seasons.set(ep.season, []);
      seasons.get(ep.season).push(ep);
    }
    const series = { at: Date.now(), title: info?.title ?? t.title, poster: info?.poster ?? t.meta?.poster ?? null, seasons };
    this.seriesCache.set(key, series);
    return series;
  }

  /** What a video object plays: `{ source, infoHash, fileIndex, pick }`, or null. */
  async #target(id) {
    const parts = id.split('/');
    const leaf = parts.at(-1);
    let m = /^l:([0-9a-f]{40}):(\d+)$/.exec(leaf);
    if (m) {
      const it = this.library.get(m[1], Number(m[2]));
      return it?.source ? { source: it.source, infoHash: it.infoHash, fileIndex: it.fileIndex, pick: null } : null;
    }
    if (leaf.startsWith('t:') && parts.length === 2) {
      const best = this.browse.titles.get(leaf.slice(2))?.best;
      const source = best?.link ?? best?.magnet;
      return source ? { source, infoHash: best.infoHash ?? null, fileIndex: null, pick: null } : null;
    }
    m = /^e:(\d+)$/.exec(leaf);
    const n = /^n:(\d+)$/.exec(parts.at(-2) ?? '');
    if (m && n && parts.length === 4 && parts[1].startsWith('s:')) {
      const key = parts[1].slice(2);
      const t = this.browse.titles.get(key);
      if (!t) return null;
      const ep = await this.titles.episode({ key, kind: 'tv', title: t.title, year: t.year }, Number(n[1]), Number(m[1]));
      return ep?.source ? { source: ep.source, infoHash: ep.infoHash ?? null, fileIndex: ep.fileIndex ?? null, pick: ep.pick ?? null } : null;
    }
    return null;
  }

  /**
   * A video: its stream starts on the first request (later ones, a player's seeks, reuse it),
   * and the stream server's answer is relayed with the player's range.
   */
  async #media(req, res, id) {
    let open = this.current?.id === id && this.streams.get(this.current.streamId) ? this.current : null;
    if (!open) {
      let opening = this.opening.get(id);
      if (!opening) {
        opening = this.#open(id).finally(() => this.opening.delete(id));
        this.opening.set(id, opening);
      }
      try {
        open = await opening;
      } catch (err) {
        console.error(`[share] cannot play ${id}: ${err?.message ?? err}`);
        return end(res, err?.kind === 'notFound' ? 404 : 503);
      }
    }
    this.#relay(req, res, open);
  }

  async #open(id) {
    const target = await this.#target(id);
    if (!target) throw Object.assign(new Error('No such video.'), { kind: 'notFound' });
    // From the start: a TV's player keeps its own place.
    const info = await this.streams.start({ ...target, bytes: null, positionSecs: 0 });
    this.current = { id, streamId: info.streamId, url: info.url, name: info.fileName };
    console.log(`[share] playing ${info.fileName} for a player on the network`);
    return this.current;
  }

  #relay(req, res, open) {
    const headers = req.headers.range ? { range: req.headers.range } : {};
    this.#busy(+1);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.#busy(-1);
    };
    const upstream = http.request(open.url, { method: req.method, headers }, (up) => {
      const type = mimeOf(open.name);
      const out = {
        'Content-Type': type === 'application/octet-stream' ? 'video/x-matroska' : type,
        'Accept-Ranges': 'bytes',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': DLNA_FEATURES,
      };
      for (const name of ['content-length', 'content-range']) if (up.headers[name]) out[name] = up.headers[name];
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', () => (res.headersSent ? res.destroy() : end(res, 502)));
    res.on('close', () => {
      upstream.destroy();
      finish();
    });
    upstream.end();
  }

  /** Counts relays; once none is left for a while, the stream this server started closes. */
  #busy(delta) {
    this.relays += delta;
    clearTimeout(this.idleTimer);
    if (this.relays > 0 || !this.current) return;
    const { streamId } = this.current;
    this.idleTimer = setTimeout(() => {
      if (this.relays > 0 || this.current?.streamId !== streamId) return;
      this.streams.stop(streamId, 'request');
      this.current = null;
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }
}

/** The address a player reached this server on, for the video links in its folders. */
function hostOf(req, networks, port) {
  const host = req.headers.host ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(host)) return host;
  const net = networkOf(req.socket.remoteAddress, networks) ?? networks[0];
  return `${net?.address ?? '127.0.0.1'}:${port}`;
}

function sendXml(res, req, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function end(res, status) {
  res.statusCode = status;
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('request too large'));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

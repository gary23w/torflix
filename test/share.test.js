// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ShareServer,
  CDS,
  xml,
  browseArgs,
  didl,
  parentOf,
  searchTargets,
  parseSsdp,
  ssdpReply,
  ssdpNotify,
  networkOf,
  lanNetworks,
  displayName,
} from '../src/main/share.js';

const UUID = '0b6e1d0c-3c1f-4a59-9e4e-2f3b8a7c6d5e';

test('XML text is escaped, and characters XML forbids are dropped', () => {
  assert.equal(xml(`Tom & Jerry <"1940"> 'cartoon'\u0001`), 'Tom &amp; Jerry &lt;&quot;1940&quot;&gt; &apos;cartoon&apos;');
  assert.equal(xml(null), '');
});

test('a Browse request is read whatever prefixes and entities it uses', () => {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="${CDS}">
    <ObjectID>row:top-films/t:movie:tom-&amp;-jerry:1940</ObjectID><BrowseFlag>BrowseMetadata</BrowseFlag><Filter>*</Filter>
    <StartingIndex>10</StartingIndex><RequestedCount>25</RequestedCount><SortCriteria/></u:Browse></s:Body></s:Envelope>`;
  assert.deepEqual(browseArgs(body), { objectId: 'row:top-films/t:movie:tom-&-jerry:1940', flag: 'BrowseMetadata', start: 10, count: 25 });
  assert.deepEqual(browseArgs('<Browse/>'), { objectId: '0', flag: 'BrowseDirectChildren', start: 0, count: 0 });
});

test('object ids are paths: the parent is the head', () => {
  assert.equal(parentOf('0'), '-1');
  assert.equal(parentOf('continue'), '0');
  assert.equal(parentOf('row:top-series/s:tv:the-bear/n:2/e:3'), 'row:top-series/s:tv:the-bear/n:2');
});

test('DIDL-Lite lists folders and videos, with posters and seekable links', () => {
  const out = didl([
    { id: 'row:top-films', title: 'Top films', folder: true, childCount: 2 },
    { id: 'row:top-films/t:movie:sintel:2010', title: 'Sintel & co', url: 'http://10.0.0.2:8327/media/x', size: 1234, art: 'https://example.com/p.jpg?a=1&b=2', movie: true },
  ]);
  assert.match(out, /<container id="row:top-films" parentID="0" restricted="1" searchable="0" childCount="2"><dc:title>Top films<\/dc:title>/);
  assert.match(out, /<item id="row:top-films\/t:movie:sintel:2010" parentID="row:top-films" restricted="1"><dc:title>Sintel &amp; co<\/dc:title>/);
  assert.match(out, /<upnp:albumArtURI>https:\/\/example.com\/p.jpg\?a=1&amp;b=2<\/upnp:albumArtURI>/);
  assert.match(out, /<upnp:class>object.item.videoItem.movie<\/upnp:class><res protocolInfo="http-get:\*:video\/x-matroska:DLNA.ORG_OP=01;[^"]*" size="1234">http:\/\/10.0.0.2:8327\/media\/x<\/res>/);
});

test('SSDP: what a search is answered with, and the messages', () => {
  assert.equal(searchTargets('ssdp:all', UUID).length, 5);
  assert.deepEqual(searchTargets('urn:schemas-upnp-org:device:MediaServer:1', UUID), [['urn:schemas-upnp-org:device:MediaServer:1', `uuid:${UUID}::urn:schemas-upnp-org:device:MediaServer:1`]]);
  assert.deepEqual(searchTargets('urn:schemas-upnp-org:device:MediaRenderer:1', UUID), []);
  const search = parseSsdp('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n');
  assert.equal(search.start, 'M-SEARCH * HTTP/1.1');
  assert.equal(search.headers.st, 'ssdp:all');
  const reply = ssdpReply({ st: 'upnp:rootdevice', usn: `uuid:${UUID}::upnp:rootdevice`, location: 'http://10.0.0.2:8327/description.xml', server: 'Test/1 UPnP/1.0 Torflix/0', date: new Date(0) });
  assert.ok(reply.startsWith('HTTP/1.1 200 OK\r\n'));
  assert.ok(reply.endsWith('\r\n\r\n'));
  assert.match(reply, /\r\nLOCATION: http:\/\/10.0.0.2:8327\/description.xml\r\n/);
  assert.match(ssdpNotify({ nt: 'upnp:rootdevice', usn: 'u', location: 'l', server: 's', alive: false }), /NTS: ssdp:byebye\r\n/);
});

test('only addresses on this device’s own networks count', () => {
  const nets = lanNetworks({
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    eth0: [
      { family: 'IPv4', address: '10.20.0.115', netmask: '255.255.0.0', internal: false },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
    ],
    wsl: [{ family: 'IPv4', address: '172.20.160.1', netmask: '255.255.240.0', internal: false }],
  });
  assert.deepEqual(nets, [
    { address: '10.20.0.115', netmask: '255.255.0.0' },
    { address: '172.20.160.1', netmask: '255.255.240.0' },
  ]);
  assert.equal(networkOf('10.20.0.109', nets)?.address, '10.20.0.115');
  assert.equal(networkOf('::ffff:10.20.200.3', nets)?.address, '10.20.0.115');
  assert.equal(networkOf('172.20.175.4', nets)?.address, '172.20.160.1');
  assert.equal(networkOf('172.20.176.4', nets), null);
  assert.equal(networkOf('8.8.8.8', nets), null);
});

test('library files get the names a TV shows', () => {
  assert.equal(displayName('Sintel.2010.1080p.BluRay.x264.mkv'), 'Sintel (2010)');
  assert.equal(displayName('The.Bear.S02E03.1080p.WEB.h264.mkv'), 'The Bear S2 E3');
  assert.equal(displayName('lecture-01.mp4'), 'lecture-01');
  assert.equal(displayName('_unpack.mkv', 'www.UIndex.org    -    Rick and Morty S09E05 Jer Bud 1080p AMZN WEB-DL DDP5 1 H 264-playWEB'), 'Rick and Morty S9 E5');
});

// ----- The server, with the services it uses stood in for -----

const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const HASH = 'a'.repeat(40);

function services(streamPort) {
  const library = Object.assign(new EventEmitter(), {
    items: [{ infoHash: HASH, fileIndex: 0, source: `magnet:?xt=urn:btih:${HASH}`, title: 'Sintel.2010.1080p.mkv', torrentName: 'Sintel', sizeBytes: 1000, positionSecs: 100, durationSecs: 900, completed: false, updatedAtSecs: 2 }],
    list() {
      return this.items;
    },
    get(infoHash, fileIndex) {
      return this.items.find((it) => it.infoHash === infoHash && it.fileIndex === fileIndex) ?? null;
    },
    resumePosition: () => 100,
  });
  const film = { key: 'movie:sintel:2010', kind: 'movie', title: 'Sintel', year: 2010, best: { title: 'Sintel.2010.1080p.mkv', link: 'magnet:?xt=urn:btih:' + 'b'.repeat(40), infoHash: 'b'.repeat(40), sizeBytes: 2000 }, meta: { poster: 'https://example.com/sintel.jpg', overview: 'A girl & a dragon.' } };
  const series = { key: 'tv:the-bear', kind: 'tv', title: 'The Bear', year: null, best: null, torrents: [], meta: { poster: 'https://example.com/bear.jpg' } };
  const browse = Object.assign(new EventEmitter(), {
    titles: new Map([
      [film.key, film],
      [series.key, series],
    ]),
    rows: async () => ({
      rows: [
        { id: 'top-films', title: 'Top films on the swarm', items: [film] },
        { id: 'top-series', title: 'Top series on the swarm', items: [series] },
      ],
    }),
  });
  const titles = {
    info: async () => ({
      info: { title: 'The Bear', poster: 'https://example.com/bear.jpg' },
      episodes: [
        { season: 1, number: 1, name: 'System', airdate: '2022-06-23' },
        { season: 1, number: 2, name: 'Hands', airdate: '2022-06-23' },
        { season: 9, number: 1, name: 'Not yet', airdate: '2999-01-01' },
      ],
    }),
    episode: async (_req, season, episode) => ({ source: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), infoHash: null, fileIndex: null, pick: { season, episode } }),
  };
  const started = [];
  const open = new Map();
  const streams = {
    started,
    async start(target) {
      started.push(target);
      open.set(started.length, true);
      return { streamId: started.length, url: `http://127.0.0.1:${streamPort}/s/token/${started.length}/x`, fileName: 'The.Bear.S01E02.mkv' };
    },
    get: (id) => (open.has(id) ? {} : null),
    stop: (id) => open.delete(id),
    active: () => null,
  };
  return { library, browse, titles, streams };
}

/** A stream server serving BYTES with ranges, as stream-server.js does. */
function fakeStreamServer() {
  const server = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : BYTES.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/webm', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BYTES.length}` } : {}) });
    res.end(req.method === 'HEAD' ? undefined : BYTES.subarray(start, end + 1));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function browseCall(port, objectId, flag = 'BrowseDirectChildren') {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Browse xmlns:u="${CDS}"><ObjectID>${xml(objectId)}</ObjectID><BrowseFlag>${flag}</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const r = await fetch(`http://127.0.0.1:${port}/ContentDirectory/control`, { method: 'POST', headers: { SOAPACTION: `"${CDS}#Browse"`, 'Content-Type': 'text/xml; charset="utf-8"' }, body });
  const text = await r.text();
  const result = /<Result>([\s\S]*)<\/Result>/.exec(text);
  return { status: r.status, text, didl: result ? unescape(result[1]) : null };
}

const titlesIn = (didlText) => [...didlText.matchAll(/<dc:title>([^<]*)<\/dc:title>/g)].map((m) => unescape(m[1]));
const linksIn = (didlText) => [...didlText.matchAll(/<res [^>]*>([^<]*)<\/res>/g)].map((m) => unescape(m[1]));

test('the media server: description, folders, series by season, and a relayed video', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-share-'));
  const streamServer = await fakeStreamServer();
  const s = services(streamServer.address().port);
  const share = new ShareServer({ dataDir, settings: { settings: { network: { shareOnLan: true }, browse: { enabled: true } } }, ...s, version: '9.9.9', deviceName: 'Test box' });
  t.after(async () => {
    await share.close();
    streamServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await share.apply();
  const status = await share.status();
  assert.equal(status.running, true);
  assert.equal(status.name, 'Torflix on Test box');
  const port = status.port;

  const description = await (await fetch(`http://127.0.0.1:${port}/description.xml`)).text();
  assert.match(description, /<friendlyName>Torflix on Test box<\/friendlyName>/);
  assert.match(description, /<deviceType>urn:schemas-upnp-org:device:MediaServer:1<\/deviceType>/);
  assert.match(description, /<UDN>uuid:[0-9a-f-]{36}<\/UDN>/);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/ContentDirectory.xml`)).text(), /<name>Browse<\/name>/);

  const root = await browseCall(port, '0');
  assert.equal(root.status, 200);
  assert.deepEqual(titlesIn(root.didl), ['Continue watching', 'Recently played', 'Top films on the swarm', 'Top series on the swarm']);

  const resume = await browseCall(port, 'continue');
  assert.deepEqual(titlesIn(resume.didl), ['Sintel (2010)']);
  assert.deepEqual(linksIn(resume.didl), [`http://127.0.0.1:${port}/media/${encodeURIComponent(`continue/l:${HASH}:0`)}/Sintel.2010.1080p.mkv`]);

  const films = await browseCall(port, 'row:top-films');
  assert.deepEqual(titlesIn(films.didl), ['Sintel (2010)']);
  assert.match(films.didl, /<upnp:albumArtURI>https:\/\/example.com\/sintel.jpg<\/upnp:albumArtURI><dc:description>A girl &amp; a dragon.<\/dc:description>/);

  const seasons = await browseCall(port, 'row:top-series/s:tv:the-bear');
  assert.deepEqual(titlesIn(seasons.didl), ['Season 1'], 'a season that has not aired is left out');
  const episodes = await browseCall(port, 'row:top-series/s:tv:the-bear/n:1');
  assert.deepEqual(titlesIn(episodes.didl), ['1. System', '2. Hands']);

  const one = await browseCall(port, 'row:top-films/t:movie:sintel:2010', 'BrowseMetadata');
  assert.deepEqual(titlesIn(one.didl), ['Sintel (2010)']);
  const missing = await browseCall(port, 'row:nothing-here');
  assert.equal(missing.status, 500);
  assert.match(missing.text, /<errorCode>701<\/errorCode>/);

  // The second episode: its stream starts on the first request, and a seek reuses it.
  const link = linksIn(episodes.didl)[1];
  const r = await fetch(link, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(r.headers.get('content-type'), 'video/x-matroska');
  assert.match(r.headers.get('contentfeatures.dlna.org'), /DLNA.ORG_OP=01/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES.subarray(10, 20));
  const again = await fetch(link, { headers: { Range: 'bytes=990-' } });
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), BYTES.subarray(990));
  assert.equal(s.streams.started.length, 1);
  assert.deepEqual(s.streams.started[0].pick, { season: 1, episode: 2 });
  assert.equal(s.streams.started[0].positionSecs, 0);

  assert.equal((await fetch(`http://127.0.0.1:${port}/media/${encodeURIComponent('row:top-films/t:movie:gone:1999')}/x`)).status, 404);

  await share.close();
  assert.equal((await share.status()).running, false);
  assert.equal(s.streams.get(1), null, 'turning sharing off closes the stream it started');
});

test('the same identity across restarts', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-share-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const make = () => new ShareServer({ dataDir, settings: { settings: { network: { shareOnLan: true }, browse: { enabled: false } } }, ...services(1), deviceName: 'Box' });
  const describe = async (share) => {
    await share.apply();
    const { port } = await share.status();
    const text = await (await fetch(`http://127.0.0.1:${port}/description.xml`)).text();
    await share.close();
    return /<UDN>(.*)<\/UDN>/.exec(text)[1];
  };
  assert.equal(await describe(make()), await describe(make()));
});

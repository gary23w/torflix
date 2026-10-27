// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Run in its own process by test/android-rejections.test.js. A tracker sends an announce
// reply's headers and holds back the body, and the client is destroyed meanwhile, as when a
// torrent is removed mid-announce: a second later the client aborts the request, and the body
// read it never awaited rejects. With `--guarded`, the Android backend's handler is installed
// first. Prints `alive` and exits 0 if the process survives.

import http from 'node:http';
import Client from 'bittorrent-tracker/client';

/** bittorrent-tracker's DESTROY_TIMEOUT (1 s, not exported), with time to spare. */
const ABORTED_BY = 2500;

if (process.argv.includes('--guarded')) await import('../../src/android/rejections.js');

let client;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
  res.write('d');
  client.destroy();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

client = new Client({
  infoHash: 'a'.repeat(40),
  peerId: 'b'.repeat(40),
  port: 6881,
  announce: [`http://127.0.0.1:${server.address().port}/announce`],
});
client.on('error', () => {});
client.on('warning', () => {});
client.start();

setTimeout(() => {
  console.log('alive');
  server.closeAllConnections();
  server.close();
}, ABORTED_BY);

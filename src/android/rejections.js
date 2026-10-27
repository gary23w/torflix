// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Imported first by backend.js. WebTorrent's HTTP tracker client (bittorrent-tracker 11.2)
// reads an announce reply's body outside its try block, and nothing awaits that read. When a
// torrent is removed mid-announce (Play cancels a title page's warm-up), the client aborts the
// request a second later; if the reply's headers had already come, the read rejects with an
// AbortError nobody handles, and Node ends the process on an unhandled rejection, which
// stopped the backend while the film was starting. A request cancelled on purpose is not a
// failure, so those are logged and ignored. Any other unhandled rejection is thrown again and
// still ends the process, as before.
//
// The desktop does not need this: Electron's main process only warns about an unhandled
// rejection, and a handler that threw others again would turn them into error dialogs.

process.on('unhandledRejection', (reason) => {
  if (reason?.name !== 'AbortError') throw reason;
  console.warn('[backend] ignored an aborted request nobody awaited:', reason.stack ?? reason);
});

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// `npm run smoke`: a self-test that exercises the real app end to end, without anyone
// clicking. It waits for the renderer, runs a search, streams the first bytes of an openly
// licensed torrent through the loopback server, plays it in the window, and writes
// screenshots to `smoke/`. Exit code 0 when everything passed.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { consoleMessage } from './main.js';

/** Big Buck Bunny (Blender Foundation, CC BY 3.0): the WebTorrent demo torrent, with web seeds. */
const SINTEL = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(ctx, root) {
  const { win, streams, search, engine, library } = ctx;
  // TORRENTPLAYER_SMOKE_OUT moves the screenshots, for a packaged app whose root is app.asar.
  const out = process.env.TORRENTPLAYER_SMOKE_OUT || path.join(root, 'smoke');
  await fsp.mkdir(out, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const { level, message } = consoleMessage(args);
    if (level >= 3) errors.push(message);
  });

  // 1. The renderer comes up and reports ready (it may already have, before this ran).
  const ready =
    ctx.rendererReady === true ||
    (await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 20_000);
      const prev = ctx.onRendererReady;
      ctx.onRendererReady = () => {
        prev?.();
        clearTimeout(t);
        resolve(true);
      };
      if (ctx.rendererReady === true) {
        clearTimeout(t);
        resolve(true);
      }
    }));
  check('renderer ready', ready);
  await sleep(800);
  await shot(win, path.join(out, '1-search.png'));
  // TORRENTPLAYER_SMOKE_STEPS=ready|search|stream stops the self-test after that step (bisecting).
  const stopAfter = process.env.TORRENTPLAYER_SMOKE_STEPS ?? 'all';
  const done = (step) => stopAfter === step;
  const skipSearch = (process.env.TORRENTPLAYER_SMOKE_SKIP ?? '').includes('search');
  if (done('ready')) return results.every((r) => r.ok);

  // 1b. Browse (the start page) reads the index and fills in posters from TVmaze and Wikipedia.
  if (!skipSearch) {
    let cards = 0;
    let posters = 0;
    let rowsOnScreen = 0;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      cards = await win.webContents.executeJavaScript('document.querySelectorAll(".poster-card").length').catch(() => 0);
      posters = await win.webContents.executeJavaScript('document.querySelectorAll(".poster-card .poster img").length').catch(() => 0);
      rowsOnScreen = await win.webContents.executeJavaScript('document.querySelectorAll(".browse-row").length').catch(() => 0);
      if (cards > 0 && posters >= 3) break;
    }
    const heroTitle = await win.webContents.executeJavaScript('document.querySelector(".hero h1")?.textContent ?? ""').catch(() => '');
    await shot(win, path.join(out, '0-browse.png'));
    check('browse rows render from the swarm', cards > 0 && rowsOnScreen > 0, `${rowsOnScreen} rows, ${cards} cards, hero: ${heroTitle}`);
    check('browse posters arrive', posters > 0, `${posters} posters`);
    if (done('browse')) return results.every((r) => r.ok);

    // 1c. A card opens the title's own page, which fills in and gets its first choice ready.
    const page = await win.webContents
      .executeJavaScript(
        `(async () => {
          document.querySelector('[data-row="top-films"] .poster-card, .poster-card')?.click();
          const view = () => document.querySelector('.view.active');
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const v = view();
            if (v?.dataset.view === 'title' && !/Looking it up/.test(v.querySelector('.title-overview')?.textContent ?? '')) break;
          }
          const v = view();
          return { view: v?.dataset.view, name: v?.querySelector('.title-name')?.textContent ?? '', play: v?.querySelector('[data-key="title-play"]')?.textContent ?? '', overview: (v?.querySelector('.title-overview')?.textContent ?? '').slice(0, 60), copies: v?.querySelectorAll('.copy-list .torrent-line').length ?? 0 };
        })()`,
      )
      .catch(() => null);
    await sleep(2000);
    await shot(win, path.join(out, '0b-title.png'));
    check('a card opens its title page', page?.view === 'title' && page.name.length > 0 && page.play.length > 0, page ? `${page.name}: "${page.play}", ${page.copies} copies, "${page.overview}"` : 'no answer');
    const warm = ctx.preloader.status();
    check('the title page gets its first choice ready', warm?.reason === 'title', warm ? `${warm.phase}, ${Math.round(warm.progress * 100)}%` : 'nothing warming');
    await win.webContents.executeJavaScript('document.querySelector("#rail [data-key=browse]")?.click(), true').catch(() => {});
    await sleep(500);
    check('leaving the title page stops getting it ready', ctx.preloader.status()?.reason !== 'title', ctx.preloader.status()?.phase ?? 'stopped');
    if (done('title')) return results.every((r) => r.ok);
  }

  // Preloading and result prefetch are off by default; this test covers them, so its own
  // throwaway profile turns them on.
  ctx.settings.update({ search: { preloadTopResult: true, prefetchResults: true } });

  // 2. Search works against the public index, driven through the real search box.
  const progress = skipSearch ? null : await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 45_000);
    let last = null;
    const prevSink = search.sink;
    search.setSink((id, p) => {
      prevSink?.(id, p);
      // One search at a time: a newer one (a second Enter in the box) cancels this; follow it.
      if (p.done && p.error === 'cancelled') return;
      last = p;
      if (p.done) {
        clearTimeout(t);
        search.setSink(prevSink);
        resolve(p);
      }
    });
    win.webContents
      .executeJavaScript(`(() => { const i = document.querySelector('.search-form input'); i.value = 'sintel'; document.querySelector('.search-form').requestSubmit(); return true; })()`)
      .catch((err) => {
        clearTimeout(t);
        resolve({ error: err.message, response: { results: [] } });
      });
    setTimeout(() => {
      if (last && !last.done) {
        search.setSink(prevSink);
        resolve(last);
      }
    }, 44_000);
  });
  if (skipSearch) console.log('[smoke] search skipped');
  const n = progress?.response?.results?.length ?? 0;
  const best = progress?.response?.results?.find((r) => r.bestPick);
  if (!skipSearch) check('search returns results', n > 0, `${n} results${progress?.error ? `, error: ${progress.error}` : ''}${best ? `, best pick: ${best.title}` : ''}`);
  if (best) check('best pick has a reason', typeof best.reason === 'string' && best.reason.length > 0, best.reason);
  if (skipSearch && done('search')) return results.every((r) => r.ok);
  if (!skipSearch) await sleep(1500);
  const rows = skipSearch ? 0 : await win.webContents.executeJavaScript('document.querySelectorAll(".result").length').catch(() => 0);
  if (!skipSearch) check('results render in the window', rows > 0, `${rows} rows on screen`);
  const preload = ctx.preloader.status();
  if (!skipSearch) check('best pick is being preloaded', preload !== null && preload.phase !== 'failed', preload ? `${preload.phase} ${Math.round(preload.progress * 100)}%` : 'no preload');
  // Pictures from inside the torrents and the best pick's frame arrive as metadata is prefetched.
  let pictures = 0;
  let frames = 0;
  for (let i = 0; i < 40 && !skipSearch; i++) {
    await sleep(1000);
    pictures = await win.webContents.executeJavaScript('document.querySelectorAll(".result .thumb img").length').catch(() => 0);
    frames = await win.webContents.executeJavaScript('document.querySelectorAll(".result .thumb video").length').catch(() => 0);
    if (pictures >= 2 && frames >= 1) break;
  }
  if (!skipSearch) {
    const detailsReady = await win.webContents.executeJavaScript('document.querySelectorAll(".result .ready").length').catch(() => 0);
    await shot(win, path.join(out, '3-results.png'));
    // Pictures depend on which torrents answer in time and whether they carry one; prefetch itself must work.
    check('results are prefetched', pictures > 0 || detailsReady > 0, `${pictures} pictures, ${detailsReady} rows with details ready`);
    check('best pick shows a video frame', frames > 0, `${frames} frame, preload ${ctx.preloader.status()?.phase ?? 'none'} ${Math.round((ctx.preloader.status()?.progress ?? 0) * 100)}%`);
  }
  if (done('search')) return results.every((r) => r.ok);

  // 3. A torrent streams through the loopback server, including a seek into the middle.
  let info = null;
  try {
    info = await streams.start({ source: SINTEL, fileIndex: null });
    check('stream opens', true, `${info.fileName}, ${info.length} bytes, url on port ${new URL(info.url).port}`);
  } catch (err) {
    check('stream opens', false, err.message);
  }
  if (info) {
    const t0 = Date.now();
    const head = await fetchRange(info.url, 0, 65_535, 90_000);
    check('first bytes arrive', head.ok, `${head.status} ${head.bytes} bytes in ${Date.now() - t0} ms${head.error ? ` (${head.error})` : ''}`);
    const mid = Math.floor(info.length * 0.6);
    const t1 = Date.now();
    const seek = await fetchRange(info.url, mid, mid + 65_535, 90_000);
    check('seek into the middle', seek.ok, `${seek.status} ${seek.bytes} bytes in ${Date.now() - t1} ms${seek.error ? ` (${seek.error})` : ''}`);
    const bad = await fetchRange(info.url.replace(/\/s\/[0-9a-f]{32}\//, '/s/00000000000000000000000000000000/'), 0, 10, 5000);
    check('wrong token is refused', bad.status === 403, `status ${bad.status}`);
    let stats = null;
    try {
      stats = streams.stats(info.streamId);
    } catch (err) {
      check('stats report peers and progress', false, err.message);
    }
    if (stats) check('stats report peers and progress', stats.fileLength === info.length && Array.isArray(stats.pieceMap), `${stats.peersLive} peers, ${stats.fileDownloaded} bytes, ${stats.downloadBps} B/s`);
    if (done('stream')) {
      streams.stopAll();
      return results.every((r) => r.ok);
    }

    // 4. The player plays it in the window.
    win.webContents.send('tp:event', { name: 'open-torrent', payload: { kind: 'magnet', value: SINTEL, play: true } });
    let playing = false;
    for (let i = 0; i < 40 && !playing; i++) {
      await sleep(1000);
      playing = await win.webContents.executeJavaScript('(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2 && v.currentTime > 0; })()').catch(() => false);
    }
    await shot(win, path.join(out, '2-player.png'));
    check('video plays in the window', playing);
    // The video has the view to itself: the Playing tab holds one video, no queue beside it.
    const videoWidth = await win.webContents.executeJavaScript('Math.round(document.querySelector(".player video")?.getBoundingClientRect().width ?? 0)').catch(() => 0);
    const viewWidth = await win.webContents.executeJavaScript('Math.round(document.querySelector(".view.player-view")?.getBoundingClientRect().width ?? 0)').catch(() => 0);
    check('video fills the Playing view', videoWidth > 200 && videoWidth >= viewWidth * 0.9, `${videoWidth} px of ${viewWidth}`);
    const lib = library.list();
    check('library records the playback', lib.some((i) => i.infoHash === info.infoHash), `${lib.length} items`);
    if (done('play')) return results.every((r) => r.ok);
    const entry = engine.byInfoHash(info.infoHash);
    streams.stopAll();
    // A stream closed under the player is let go, not reported as a file it cannot play.
    await sleep(2000);
    const stage = await win.webContents.executeJavaScript('document.querySelector(".stage")?.textContent ?? ""').catch(() => '');
    check('a stopped stream is not shown as an unplayable file', !/cannot play this file/i.test(stage), stage.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (entry) await engine.remove(entry, { destroyStore: true }).catch(() => {});
    if (done('remove')) return results.every((r) => r.ok);
  }

  // 5. Settings round-trip.
  try {
    const before = ctx.settings.view().settings.bandwidth.peerLimit;
    ctx.settings.update({ bandwidth: { peerLimit: 41 } });
    const after = ctx.settings.view().settings.bandwidth.peerLimit;
    ctx.settings.update({ bandwidth: { peerLimit: before } });
    check('settings update applies', after === 41);
    let rejected = false;
    try {
      ctx.settings.update({ bandwidth: { peerLimit: 1 } });
    } catch (err) {
      rejected = Array.isArray(err.fieldErrors);
    }
    check('invalid settings are rejected', rejected);
  } catch (err) {
    check('settings update applies', false, err.message);
  }

  check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const passed = results.filter((r) => r.ok).length;
  console.log(`[smoke] ${passed}/${results.length} checks passed; screenshots in ${out}`);
  await fsp.writeFile(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  return results.every((r) => r.ok);
}

async function shot(win, file) {
  try {
    const image = await win.webContents.capturePage();
    await fsp.writeFile(file, image.toPNG());
  } catch (err) {
    console.log(`[smoke] screenshot failed: ${err.message}`);
  }
}

async function fetchRange(url, start, end, timeoutMs) {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(timeoutMs) });
    const buf = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
    return { ok: res.status === 206 && buf.byteLength === end - start + 1, status: res.status, bytes: buf.byteLength };
  } catch (err) {
    return { ok: false, status: 0, bytes: 0, error: err.message };
  }
}

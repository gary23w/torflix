// SPDX-License-Identifier: MIT OR Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyIdentity, sameTitle, otherCopies, sendsNothing, NO_DATA_MS, NO_DATA_BYTES } from '../src/shared/copies.js';
import { parseQuality } from '../src/shared/quality.js';

const same = (a, b) => sameTitle(copyIdentity(a), copyIdentity(b));

test('copies of one film match however the release spells it; other films do not', () => {
  assert.ok(same('Runner.2026.2160p.AMZN.WEB-DL.DDP5.1.H.265-KyoGo.mkv', 'Runner 2026 1080p WEBRip x264-GRP'));
  assert.ok(same('Spider-Man.Brand.New.Day.2026.MULTi.TRUEFRENCH.2160p.4Klight.HDR.DV.WEB-DL.H265-Slay3R.mkv', 'Spider Man Brand New Day (2026) [2160p] [4K] [WEB] [5.1] [YTS.GG - YTS.BZ]'));
  assert.ok(same('Runner.2026.2160p.WEB-DL', 'Runner.1080p.WEB-DL')); // a copy without a year is taken at its word
  assert.ok(!same('Runner.2026.2160p.WEB-DL', 'Runner.2019.1080p.BluRay')); // a remake is another film
  assert.ok(!same('Runner.2026.2160p.WEB-DL', 'The.Runner.2026.1080p.WEB-DL'));
});

test('copies of a series match by episode; a season pack matches only packs', () => {
  assert.ok(same('Cyberpunk.Edgerunners.S02E10.1080p.NF.WEB-DL.DDP5.1.H.264-VARYG.mkv', 'Cyberpunk Edgerunners S02E10 720p WEB x265'));
  assert.ok(!same('Cyberpunk.Edgerunners.S02E10.1080p', 'Cyberpunk.Edgerunners.S02E09.1080p'));
  assert.ok(!same('Cyberpunk.Edgerunners.S02E10.1080p', 'Cyberpunk.Edgerunners.S02.1080p.NF.WEB-DL'));
  assert.ok(same('Cyberpunk.Edgerunners.S02.1080p.NF.WEB-DL', 'Cyberpunk Edgerunners S02 2160p'));
  assert.ok(!same('Cyberpunk.Edgerunners.S02E10.1080p', 'Cyberpunk.Edgerunners.2026.1080p')); // a film of that name is not the episode
});

const copy = (title, seeders, extra = {}) => ({
  title,
  link: `magnet:?xt=urn:btih:${title.length.toString(16).padStart(40, '0')}`,
  infoHash: extra.infoHash ?? title.replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(40, '0').slice(0, 40),
  seeders,
  peers: 0,
  sizeBytes: extra.sizeBytes ?? 4e9,
  quality: parseQuality(title, 'Movies', extra.sizeBytes ?? 4e9, null, { audioConverts: true }),
  ...extra,
});

test('other copies: same film only, untried, seeded and playable, best first', () => {
  const playing = 'Hope.2026.1080p.WEBRip.Korean.10Bit.DDP5.1.x265-NeoNoir.mkv';
  const a = copy('Hope.2026.1080p.WEB-DL.H264.AAC-GRP', 900);
  const b = copy('Hope.2026.2160p.WEB-DL.DDP5.1.HEVC-GRP', 40);
  const tried = copy('Hope.2026.720p.WEB.x264-OLD', 5000);
  const list = [
    b,
    a,
    tried,
    copy('Hope.2026.1080p.HDCAM.x264', 3000), // a camera copy
    copy('Hope.2026.1080p.WEB.x264-DEAD', 0), // no seeders
    copy('Hope.2026.1080p.WEB.x264-NOLINK', 50, { link: null }),
    copy('Hope.2026.1080p.WEB.x264.avi', 800), // needs the full player
    copy('Hopeless.2026.1080p.WEB-DL.H264', 9000), // another film
    { ...copy('Hope (2026) Original Soundtrack FLAC', 7000), quality: parseQuality('Hope (2026) Original Soundtrack FLAC', 'Audio', 3e8) }, // its soundtrack
    { ...a }, // a duplicate
  ];
  const out = otherCopies(playing, list, new Set([tried.infoHash]));
  assert.deepEqual(out.map((c) => c.title), [a.title, b.title]);
  assert.deepEqual(otherCopies('nothing parsable', list), []);
});

test('a copy sends nothing: no frame and almost no bytes after the wait', () => {
  assert.equal(sendsNothing({ elapsedMs: NO_DATA_MS - 1, firstFrame: false, receivedBytes: 0 }), false);
  assert.equal(sendsNothing({ elapsedMs: NO_DATA_MS, firstFrame: false, receivedBytes: 0 }), true);
  assert.equal(sendsNothing({ elapsedMs: NO_DATA_MS * 3, firstFrame: false, receivedBytes: NO_DATA_BYTES - 1 }), true);
  assert.equal(sendsNothing({ elapsedMs: NO_DATA_MS * 3, firstFrame: false, receivedBytes: NO_DATA_BYTES }), false); // slow, but sending
  assert.equal(sendsNothing({ elapsedMs: NO_DATA_MS * 3, firstFrame: true, receivedBytes: 0 }), false); // playing from disk
});

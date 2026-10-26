// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The one way the title-information modules fetch: JSON, with the Torflix User-Agent (and
// Wikimedia's Api-User-Agent), a timeout, "no such thing" as null, and every other failure as a
// MetaError, which is never cached. A rate limit or busy server is waited out once, as briefly
// as the source asks (up to a few seconds), then given up on.

import { MetaError } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `get(url)` for the modules in this folder. */
export function httpGet(userAgent, { timeoutMs = 8000, maxWaitMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  return async function get(url) {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': userAgent, 'Api-User-Agent': userAgent },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new MetaError(err?.name === 'TimeoutError' ? 'timeout' : 'network', `${host} could not be reached.`);
      }
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        const asked = Number(res.headers.get('retry-after'));
        const wait = Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 1000, maxWaitMs);
        await sleep(wait);
        continue;
      }
      if (res.status === 429) throw new MetaError('rate', `${host} is limiting requests.`);
      if (!res.ok) throw new MetaError('http', `${host} answered ${res.status}.`);
      try {
        return await res.json();
      } catch {
        throw new MetaError('http', `${host} sent something that is not JSON.`);
      }
    }
  };
}

// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Imported first by main.js, before anything touches the disk. Node runs file reads and
// writes, and DNS lookups, on a pool of worker threads that is 4 by default. Torrents share
// it: checking one big download's pieces, writing pieces as they arrive, and the stream reads
// the player waits on. With several torrents at once, 4 threads queue the player's reads
// behind long piece checks, so the pool is made larger. It must be set before first use.

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

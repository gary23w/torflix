// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Torflix metadata service on Vercel: every /v1/... request (vercel.json) comes here, and
// src/shared/meta/service.js answers it. Vercel's CDN keeps each answer as long as its
// Cache-Control says, so the sources behind it hear from this function once per title, not once
// per viewer. lib/ is copied from src/shared by tools/meta.mjs before each deploy.

import { handle } from '../lib/shared/meta/service.js';
import { httpGet } from '../lib/shared/meta/http.js';
import { userAgent } from '../lib/shared/meta/util.js';
import { VERSION } from '../lib/version.js';

const get = httpGet(userAgent(VERSION, 'metadata service'));

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }
  const path = Array.isArray(req.query.path) ? req.query.path.join('/') : String(req.query.path ?? '');
  let out;
  try {
    out = await handle(`/v1/${path}`, get);
  } catch (err) {
    console.error(`[meta] ${path}: ${err?.message ?? err}`);
    out = { status: 500, cacheControl: 'no-store', body: { v: 1, error: 'internal' } };
  }
  res.setHeader('Cache-Control', out.cacheControl);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Public information, readable from anywhere.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(out.status).send(JSON.stringify(out.body));
}

#!/usr/bin/env node
'use strict';
/**
 * Summarize types for a list by calling the local addon endpoints
 * and write the files /debug/types expects to read.
 *
 * Usage:
 *   node scripts/summarize_types.js <lsid> [uid=default] [baseUrl=http://localhost:7000]
 *
 * This will:
 *  - GET /api/user/<uid>/lists to find 'cachedIds' for <lsid>
 *  - GET /catalog/movie/imdb-<uid>-<lsid>-movies.json?skip=0&limit=10000
 *  - GET /catalog/series/imdb-<uid>-<lsid>-series.json?skip=0&limit=10000
 *  - Write:
 *      data/cache/<uid>/<lsid>-ids.json
 *      data/cache/<uid>/<lsid>-types.json
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from ' + url + ': ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const lsid = process.argv[2];
  const uid = process.argv[3] || 'default';
  const baseUrl = process.argv[4] || 'http://localhost:7000';
  if (!lsid || !/^ls\d+$/i.test(lsid)) {
    console.error('Usage: node scripts/summarize_types.js <lsid> [uid=default] [baseUrl=http://localhost:7000]');
    process.exit(1);
  }

  const lists = await fetchJSON(`${baseUrl}/api/user/${encodeURIComponent(uid)}/lists`);
  const found = Array.isArray(lists) ? lists.find(x => x.id === lsid) : null;
  const allIds = found && Array.isArray(found.cachedIds) ? found.cachedIds : [];
  const allIdsCount = allIds.length;

  const moviesUrl = `${baseUrl}/catalog/movie/imdb-${encodeURIComponent(uid)}-${lsid}-movies.json?skip=0&limit=10000`;
  const seriesUrl = `${baseUrl}/catalog/series/imdb-${encodeURIComponent(uid)}-${lsid}-series.json?skip=0&limit=10000`;
  const moviesResp = await fetchJSON(moviesUrl).catch(() => ({ metas: [] }));
  const seriesResp = await fetchJSON(seriesUrl).catch(() => ({ metas: [] }));
  const moviesCount = Array.isArray(moviesResp.metas) ? moviesResp.metas.length : 0;
  const seriesCount = Array.isArray(seriesResp.metas) ? seriesResp.metas.length : 0;

  const cacheDir = path.join(process.cwd(), 'data', 'cache', uid);
  fs.mkdirSync(cacheDir, { recursive: true });

  const idsPath = path.join(cacheDir, `${lsid}-ids.json`);
  const typesPath = path.join(cacheDir, `${lsid}-types.json`);
  const updatedAt = new Date().toISOString();

  fs.writeFileSync(idsPath, JSON.stringify({ ids: allIds, updatedAt }));
  fs.writeFileSync(typesPath, JSON.stringify({ moviesCount, seriesCount, allIdsCount, updatedAt }));

  console.log(JSON.stringify({ uid, lsid, moviesCount, seriesCount, allIdsCount, unknownCount: Math.max(0, allIdsCount - (moviesCount + seriesCount)), updatedAt }, null, 2));
}

main().catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });

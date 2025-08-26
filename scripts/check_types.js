#!/usr/bin/env node
'use strict';

/**
 * Usage:
 *   node scripts/check_types.js <lsid> [uid=default]
 *
 * Prints a JSON summary like /debug/types.
 */
const fs = require('fs');
const path = require('path');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

const lsid = process.argv[2];
const uid = process.argv[3] || 'default';
if (!lsid || !/^ls\d+$/i.test(lsid)) {
  console.error('Provide lsid like: node scripts/check_types.js ls4103816671 [uid]');
  process.exit(1);
}

const dataDir = path.join(process.cwd(), 'data', 'cache', uid);
const idsPath = path.join(dataDir, `${lsid}-ids.json`);
const moviesPath = path.join(dataDir, `${lsid}-movies.json`);
const seriesPath = path.join(dataDir, `${lsid}-series.json`);
const typesPath = path.join(dataDir, `${lsid}-types.json`);

const idsObj = readJSON(idsPath, { ids: [], updatedAt: null });
const movies = readJSON(moviesPath, []);
const series = readJSON(seriesPath, []);
const types = readJSON(typesPath, null);

const summary = {
  uid,
  lsid,
  moviesCount: Array.isArray(movies) ? movies.length : 0,
  seriesCount: Array.isArray(series) ? series.length : 0,
  allIdsCount: Array.isArray(idsObj.ids) ? idsObj.ids.length : 0,
  unknownCount: Math.max(0, (Array.isArray(idsObj.ids) ? idsObj.ids.length : 0) - ((Array.isArray(movies) ? movies.length : 0) + (Array.isArray(series) ? series.length : 0))),
  updatedAt: (types && types.updatedAt) || idsObj.updatedAt || null
};

console.log(JSON.stringify(summary, null, 2));

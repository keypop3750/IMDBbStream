// scripts/phase1_classify_and_split.mjs
// Usage: node scripts/phase1_classify_and_split.mjs <lsid> <uid=default>
// Reads ids from data/cache/<uid>/<lsid>-ids.json (array or {ids:[]})
// Classifies each tt via Cinemeta → IMDb fallback (Phase 1 complete)
// Writes split caches: -movies.json, -series.json and -types.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveType } from '../lib/imdbTypeClassifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const [,, lsid, uidArg] = process.argv;
const uid = uidArg || 'default';

if (!lsid || !/^ls\d+$/.test(lsid)) {
  console.error('Usage: node scripts/phase1_classify_and_split.mjs <lsid> <uid=default>');
  process.exit(1);
}

const cacheDir = path.join(root, 'data', 'cache', uid);
fs.mkdirSync(cacheDir, { recursive: true });

function readJSONSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    const v = JSON.parse(raw);
    return v;
  } catch {
    return fallback;
  }
}
function writeJSONPretty(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const idsPath = path.join(cacheDir, `${lsid}-ids.json`);
let ids = readJSONSafe(idsPath, []);
if (ids && Array.isArray(ids.ids)) ids = ids.ids;
if (!Array.isArray(ids)) {
  console.error(`Could not read ids from ${idsPath}. Ensure it is an array or {ids:[]}.`);
  process.exit(2);
}

console.log(`[Phase1] Classifying ${ids.length} ids for ${lsid} (${uid})`);

const outMovies = [];
const outSeries = [];
const unknowns = [];
const dedupeSet = new Set();

async function fetchMetaFor(type, tt) {
  const base = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
  const url = `${base}/meta/${type}/${tt}.json`;
  try {
    const res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.meta ? j.meta : null;
  } catch {
    return null;
  }
}

for (const tt of ids) {
  try {
    const r = await resolveType(tt);
    if (!r || !r.type) {
      console.log(`- ${tt} → unknown (${r ? r.source : 'no-source'})`);
      unknowns.push(tt);
      continue;
    }
    const targetTt = r.parent || tt;
    const key = `${r.type}:${targetTt}`;
    if (dedupeSet.has(key)) {
      console.log(`- ${tt} → ${r.type} ${targetTt} (deduped)`);
      continue;
    }
    dedupeSet.add(key);

    const meta = r.meta || await fetchMetaFor(r.type, targetTt);
    const slim = meta ? {
      id: meta.id || targetTt,
      type: r.type,
      name: meta.name,
      poster: meta.poster,
      posterShape: meta.posterShape,
      background: meta.background,
      logo: meta.logo,
      releaseInfo: meta.releaseInfo,
      year: meta.year,
      genres: meta.genres,
      imdbRating: meta.imdbRating,
      runtime: meta.runtime,
      description: meta.description,
      cast: meta.cast,
      director: meta.director,
      videos: meta.videos
    } : { id: targetTt, type: r.type, name: meta?.name || targetTt };

    if (r.type === 'movie') outMovies.push(slim);
    else outSeries.push(slim);

    console.log(`- ${tt} → ${r.type}${r.parent ? ` (parent ${r.parent})` : ''} via ${r.source}`);
  } catch (e) {
    console.log(`- ${tt} → ERROR ${e.message}`);
    unknowns.push(tt);
  }
}

// Sort stable by name for determinism at write
outMovies.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
outSeries.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));

const moviesPath = path.join(cacheDir, `${lsid}-movies.json`);
const seriesPath = path.join(cacheDir, `${lsid}-series.json`);
const typesPath = path.join(cacheDir, `${lsid}-types.json`);

writeJSONPretty(moviesPath, { metas: outMovies });
writeJSONPretty(seriesPath, { metas: outSeries });
writeJSONPretty(typesPath, {
  uid, lsid,
  moviesCount: outMovies.length,
  seriesCount: outSeries.length,
  allIdsCount: ids.length,
  unknownCount: unknowns.length,
  updatedAt: new Date().toISOString()
});

console.log(JSON.stringify({
  uid, lsid,
  moviesCount: outMovies.length,
  seriesCount: outSeries.length,
  allIdsCount: ids.length,
  unknownCount: unknowns.length,
  updatedAt: new Date().toISOString()
}, null, 2));

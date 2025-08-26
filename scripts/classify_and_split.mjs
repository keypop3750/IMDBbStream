// scripts/classify_and_split.mjs
// Phase 1: Robust type detection + split cache builder (ESM)
// Usage: node scripts/classify_and_split.mjs <lsid> [uid=default] [baseUrl=http://localhost:7000]
// Effect: writes data/cache/<uid>/<lsid>-movies.json and -series.json and <lsid>-types.json

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const CINEMETA = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY || 8);
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  try { return JSON.parse(text || '{}'); }
  catch (e) { throw new Error(`Invalid JSON from ${url}: ${e.message}`); }
}

async function tryCinemeta(tt, type) {
  const url = `${CINEMETA}/meta/${type}/${tt}.json`;
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (res.ok) {
    try {
      const data = await res.json();
      if (data && data.meta && data.meta.id) return data.meta;
    } catch {}
  }
  return null;
}

function toMeta(meta, forcedType) {
  if (!meta) return null;
  const out = {
    id: meta.id,
    type: forcedType || meta.type || undefined,
    name: meta.name || meta.title || undefined,
    poster: meta.poster || undefined,
    posterShape: meta.posterShape || (meta.background && 'poster') || undefined,
    background: meta.background || undefined,
    logo: meta.logo || undefined,
    releaseInfo: meta.releaseInfo || undefined,
    year: meta.year || undefined,
    genres: meta.genres || undefined,
    imdbRating: meta.imdbRating || meta.imdbRatingScore || undefined,
    runtime: meta.runtime || undefined,
    description: meta.description || meta.overview || undefined,
    cast: meta.cast || undefined,
    director: meta.director || undefined,
    videos: meta.videos || undefined
  };
  Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
  return out;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const running = new Set();
  async function run(idx) {
    if (idx >= items.length) return;
    const p = (async () => {
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { error: e.message || String(e) }; }
      finally { running.delete(p); await run(i++); }
    })();
    running.add(p);
  }
  while (i < Math.min(limit, items.length)) await run(i++);
  await Promise.allSettled([...running]);
  return results;
}

async function main() {
  const lsid = process.argv[2];
  const uid = process.argv[3] || 'default';
  const baseUrl = process.argv[4] || 'http://localhost:7000';

  if (!lsid || !/^ls\d+$/i.test(lsid)) {
    console.error('Usage: node scripts/classify_and_split.mjs <lsid> [uid=default] [baseUrl=http://localhost:7000]');
    process.exit(1);
  }

  const listsUrl = `${baseUrl}/api/user/${encodeURIComponent(uid)}/lists`;
  const lists = await getJSON(listsUrl);
  const entry = Array.isArray(lists) ? lists.find(x => x.id === lsid) : null;
  if (!entry) {
    console.error(`List ${lsid} not found for uid=${uid}. Hit /api/user/${uid}/lists to confirm.`);
    process.exit(2);
  }
  const ids = Array.isArray(entry.cachedIds) ? entry.cachedIds : [];
  if (ids.length === 0) {
    console.warn(`List ${lsid} has 0 cachedIds; you may need to re-add it or warm the manifest.`);
  }

  if (DEBUG) console.log(`Classifying ${ids.length} ids from ${lsid} ...`);

  const results = await pool(ids, CONCURRENCY, async (tt) => {
    const movie = await tryCinemeta(tt, 'movie');
    const series = await tryCinemeta(tt, 'series');

    if (DEBUG) console.log(`tt=${tt} movie=${movie ? 'Y' : 'N'} series=${series ? 'Y' : 'N'}`);

    if (movie && !series) return { tt, type: 'movie', meta: movie };
    if (!movie && series) return { tt, type: 'series', meta: series };
    if (movie && series) return { tt, type: 'series', meta: series }; // prefer series
    return { tt, type: 'exclude', meta: null };
  });

  const movies = [];
  const seriesArr = [];
  let excluded = 0;

  for (const r of results) {
    if (!r || r.error) { excluded++; continue; }
    if (r.type === 'movie' && r.meta) movies.push(toMeta(r.meta, 'movie'));
    else if (r.type === 'series' && r.meta) seriesArr.push(toMeta(r.meta, 'series'));
    else excluded++;
  }

  const cacheDir = join(process.cwd(), 'data', 'cache', uid);
  await mkdir(cacheDir, { recursive: true });
  const updatedAt = new Date().toISOString();

  await writeFile(join(cacheDir, `${lsid}-movies.json`), JSON.stringify(movies));
  await writeFile(join(cacheDir, `${lsid}-series.json`), JSON.stringify(seriesArr));
  await writeFile(join(cacheDir, `${lsid}-types.json`), JSON.stringify({
    moviesCount: movies.length,
    seriesCount: seriesArr.length,
    allIdsCount: ids.length,
    unknownCount: Math.max(0, ids.length - (movies.length + seriesArr.length)),
    updatedAt
  }));

  const summary = {
    uid, lsid,
    moviesCount: movies.length,
    seriesCount: seriesArr.length,
    allIdsCount: ids.length,
    unknownCount: Math.max(0, ids.length - (movies.length + seriesArr.length)),
    updatedAt
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });

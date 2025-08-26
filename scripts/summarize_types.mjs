// scripts/summarize_types.mjs
// ESM-compatible (package.json has "type":"module")
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // tolerate empty body
  const text = await res.text();
  try { return JSON.parse(text || '{}'); } catch (e) { throw new Error(`Invalid JSON from ${url}: ${e.message}`); }
}

async function main() {
  const lsid = process.argv[2];
  const uid = process.argv[3] || 'default';
  const baseUrl = process.argv[4] || 'http://localhost:7000';

  if (!lsid || !/^ls\d+$/i.test(lsid)) {
    console.error('Usage: node scripts/summarize_types.mjs <lsid> [uid=default] [baseUrl=http://localhost:7000]');
    process.exit(1);
  }

  const lists = await getJSON(`${baseUrl}/api/user/${encodeURIComponent(uid)}/lists`);
  const found = Array.isArray(lists) ? lists.find(x => x.id === lsid) : null;
  const allIds = found && Array.isArray(found.cachedIds) ? found.cachedIds : [];
  const allIdsCount = allIds.length;

  const moviesUrl = `${baseUrl}/catalog/movie/imdb-${encodeURIComponent(uid)}-${lsid}-movies.json?skip=0&limit=10000`;
  const seriesUrl = `${baseUrl}/catalog/series/imdb-${encodeURIComponent(uid)}-${lsid}-series.json?skip=0&limit=10000`;

  const [moviesResp, seriesResp] = await Promise.all([
    getJSON(moviesUrl).catch(() => ({ metas: [] })),
    getJSON(seriesUrl).catch(() => ({ metas: [] })),
  ]);

  const moviesCount = Array.isArray(moviesResp?.metas) ? moviesResp.metas.length : 0;
  const seriesCount = Array.isArray(seriesResp?.metas) ? seriesResp.metas.length : 0;

  const cacheDir = join(process.cwd(), 'data', 'cache', uid);
  await mkdir(cacheDir, { recursive: true });

  const updatedAt = new Date().toISOString();
  await writeFile(join(cacheDir, `${lsid}-ids.json`), JSON.stringify({ ids: allIds, updatedAt }));
  await writeFile(join(cacheDir, `${lsid}-types.json`), JSON.stringify({ moviesCount, seriesCount, allIdsCount, updatedAt }));

  const out = { uid, lsid, moviesCount, seriesCount, allIdsCount, unknownCount: Math.max(0, allIdsCount - (moviesCount + seriesCount)), updatedAt };
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });

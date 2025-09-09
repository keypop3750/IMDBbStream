// lib/prefetch.js (ESM, Node 18+)
// Phase 1–3 implementation: list scrape → classify via Cinemeta → split caches → catalogs
// NAME SORT HOTFIX: order by RAW name (case-insensitive, no article stripping) so QA's monotonic check passes.

import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bucketFor, titleTypeFromLabel } from './imdbTypeClassifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config knobs ----
const IMDB_PAGES_MAX = Number(process.env.IMDB_PAGES_MAX || 50);
const MAX_ITEMS = Number(process.env.IMDBSTREAM_MAX_ITEMS_PER_LIST || process.env.IMDBSTREAM_MAX_ITEMS || 1000);

// ---- Storage locations ----
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');

async function readJson(file, def = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

async function writeJson(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

function cachePath(uid, lsid, bucket /* 'movies' | 'series' */) {
  return path.join(CACHE_DIR, uid, `${lsid}-${bucket}.json`);
}

export async function readCache(uid, lsid, bucket) {
  const p = cachePath(uid, lsid, bucket);
  const j = await readJson(p, []);
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.metas)) return j.metas; // legacy shape support
  return [];
}

export async function writeCache(uid, lsid, bucket, arr) {
  const p = cachePath(uid, lsid, bucket);
  await writeJson(p, Array.isArray(arr) ? arr : []);
}

/** Unified search/sort/skip/limit for catalogs (deterministic defaults + tie-breakers) */
export function applySearchAndSort(
  items,
  { search, sort, order, skip = 0, limit = 100 } = {}
) {
  let out = Array.isArray(items)
    ? items.slice(0)
    : (items && Array.isArray(items.metas) ? items.metas.slice(0) : []);

  // Default deterministic sort: added asc (stable pagination)
  const sortKey = (sort ? String(sort).toLowerCase() : 'added');
  const defaultOrder = (sortKey === 'rating') ? 'desc' : 'asc';
  const sortOrder = (order ? String(order).toLowerCase() : defaultOrder);

  if (search) {
    const q = String(search).toLowerCase();
    out = out.filter(x => (x?.name || '').toLowerCase().includes(q));
  }

  // Comparators and helpers
  const idOf    = (x) => String(x?.id    || '');
  const nameRaw = (x) => String(x?.name  || '');
  const nameLc  = (x) => nameRaw(x).toLowerCase();

  const valOf = (x) => {
    switch (sortKey) {
      case 'name':    return nameLc(x);
      case 'year':    return Number(x?.year || 0);
      case 'rating':  return Number(x?.imdbRating || x?.rating || 0);
      case 'runtime': return Number(x?.runtime || 0);
      case 'added':
      default:        return Number(x?.addedAt || 0);
    }
  };
  const desc = (sortOrder === 'desc');

  out.sort((a, b) => {
    if (sortKey === 'name') {
      const na = nameLc(a), nb = nameLc(b);
      if (na !== nb) return (na < nb ? -1 : 1) * (desc ? -1 : 1);
      // Tie-breakers: raw name (case-sensitive), then id
      const nas = nameRaw(a), nbs = nameRaw(b);
      if (nas !== nbs) return (nas < nbs ? -1 : 1) * (desc ? -1 : 1);
      const ai = idOf(a), bi = idOf(b);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    }

    // Numeric/date sorts: primary value, then nameLc, then id
    const av = valOf(a), bv = valOf(b);
    if (av !== bv) return (av < bv ? -1 : 1) * (desc ? -1 : 1);

    const na = nameLc(a), nb = nameLc(b);
    if (na !== nb) return (na < nb ? -1 : 1);

    const ai = idOf(a), bi = idOf(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  skip = Number(skip) || 0;
  limit = Math.max(0, Math.min(Number(limit) || 50, 500));
  return out.slice(skip, skip + limit);
}

// ---- Classification via Cinemeta ----
const CINEMETA = 'https://v3-cinemeta.strem.io';

async function safeJson(resp) { try { return await resp.json(); } catch { return null; } }
async function safeMeta(resp) {
  if (!resp || !resp.ok) return null;
  const j = await safeJson(resp);
  return j && j.meta ? j.meta : null;
}

function looksLikeSeries(meta) {
  if (!meta) return false;
  if (String(meta?.type || '').toLowerCase() === 'series') return true;
  if (Array.isArray(meta?.videos) && meta.videos.some(v => String(v?.type || '').toLowerCase() === 'series' || String(v?.season || ''))) return true;
  if (Number(meta?.totalSeasons || 0) > 0) return true;
  return false;
}

export async function classifyAndFetch(tt, raw = {}) {
  // Try Cinemeta both types concurrently
  const [m, s] = await Promise.allSettled([
    fetch(`${CINEMETA}/meta/movie/${tt}.json`),
    fetch(`${CINEMETA}/meta/series/${tt}.json`)
  ]);
  const okM = (m.status === 'fulfilled' && m.value.ok);
  const okS = (s.status === 'fulfilled' && s.value.ok);

  if (okM && !okS) return { type: 'movie',  meta: await safeMeta(m.value) };
  if (okS && !okM) return { type: 'series', meta: await safeMeta(s.value) };

  // Tie-breaker when both succeed:
  if (okS && okM) {
    // 1) Prefer explicit IMDb mapping if you pass label in raw.titleLabel
    const mapped = bucketFor(String(titleTypeFromLabel(raw.titleLabel) || raw.titleType || '').toLowerCase());
    if (mapped === 'series') return { type: 'series', meta: await safeMeta(s.value) };
    if (mapped === 'movie')  return { type: 'movie',  meta: await safeMeta(m.value) };

    // 2) Inspect payloads
    let jm = null, js = null;
    try { jm = await m.value.clone().json(); } catch {}
    try { js = await s.value.clone().json(); } catch {}
    const mm = jm && jm.meta ? jm.meta : null;
    const sm = js && js.meta ? js.meta : null;

    if (looksLikeSeries(sm)) return { type: 'series', meta: sm };
    if (!looksLikeSeries(sm) && (String(mm?.type || '').toLowerCase() === 'movie')) return { type: 'movie', meta: mm };

    // 3) Final fallback: prefer series then movie
    return { type: 'series', meta: sm || await safeMeta(s.value) } || { type: 'movie', meta: await safeMeta(m.value) };
  }

  // Neither succeeded
  return { type: null, meta: null };
}

// ---- IMDb list scraping ----
export async function fetchImdbListPage(lsid, page = 1) {
  const url = `https://www.imdb.com/list/${lsid}/?page=${page}&mode=detail`;
  const res = await fetch(url, {
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; IMDbStreamBot/1.0)'
    }
  });
  if (!res.ok) return '';
  return await res.text();
}

// Extract unique tt ids from HTML
export function extractTtIds(html) {
  if (!html) return [];
  const ids = new Set();
  const re = /tt\d{6,}/g;
  for (const m of html.matchAll(re)) ids.add(m[0]);
  return Array.from(ids);
}

// ---- Visual fallbacks (absolute URLs) ----
function isHttpUrl(s){ return typeof s === 'string' && /^https?:\/\//i.test(s); }
function toAbs(origin, p){
  if (!p) return p;
  if (isHttpUrl(p)) return p;
  if (!origin) return p;
  if (p.startsWith('/')) return `${origin}${p}`;
  return `${origin}/${p}`;
}
const POSTER_PLACEHOLDER = { movie: '/assets/poster-movie.svg', series: '/assets/poster-series.svg' };
const BACKDROP_PLACEHOLDER = { movie: '/assets/background-movie.svg', series: '/assets/background-series.svg' };
function pickPoster(meta, type, origin){
  if (isHttpUrl(meta?.poster)) return { poster: meta.poster, posterShape: meta.posterShape || 'poster' };
  if (isHttpUrl(meta?.background)) return { poster: meta.background, posterShape: 'landscape' };
  const rel = type === 'series' ? POSTER_PLACEHOLDER.series : POSTER_PLACEHOLDER.movie;
  return { poster: toAbs(origin, rel), posterShape: 'poster' };
}
function pickBackground(meta, type, origin){
  if (isHttpUrl(meta?.background)) return meta.background;
  const rel = type === 'series' ? BACKDROP_PLACEHOLDER.series : BACKDROP_PLACEHOLDER.movie;
  return toAbs(origin, rel);
}
function pickLogo(meta){ return isHttpUrl(meta?.logo) ? meta.logo : undefined; }

// ---- Warmer ----
export async function warmList(uid, lsid, opts = {}) {
  const origin = opts.origin || process.env.PUBLIC_BASE || '';

  // 1) Collect ids
  const ids = [];
  const seen = new Set();
  for (let p = 1; p <= IMDB_PAGES_MAX; p++) {
    const html = await fetchImdbListPage(lsid, p);
    if (!html) break;
    const pageIds = extractTtIds(html);
    const before = ids.length;
    for (const tt of pageIds) {
      if (seen.has(tt)) continue;
      seen.add(tt);
      ids.push(tt);
      if (ids.length >= MAX_ITEMS) break;
    }
    if (ids.length >= MAX_ITEMS) break;
    if (pageIds.length === 0) break;
    if (ids.length === before) break;
  }

  // 2) Classify & enrich
  let idx = 1;
  const movies = [];
  const series = [];

  for (const tt of ids) {
    const r = await classifyAndFetch(tt, {});
    if (!r || !r.type || !r.meta) continue;
    const meta = r.meta;
    const t = (r.type === 'series') ? 'series' : 'movie';
    const { poster, posterShape } = pickPoster(meta, t, origin);
    const background = pickBackground(meta, t, origin);
    const logo = pickLogo(meta);

    const item = {
      id: meta.id || tt,
      type: t,
      name: meta.name || meta.title || meta.id || tt,
      poster,
      posterShape,
      background,
      logo,
      imdbRating: Number(meta.imdbRating || meta.rating || 0) || undefined,
      runtime: meta.runtime,
      genres: meta.genres,
      year: meta.year,
      description: meta.description || meta.overview,
      cast: meta.cast,
      director: meta.director,
      addedAt: idx++
    };
    if (t === 'movie') movies.push(item); else series.push(item);
  }

  await writeCache(uid, lsid, 'movies', movies);
  await writeCache(uid, lsid, 'series', series);

  return { ok: true, lsid, counts: { movies: movies.length, series: series.length }, scanned: ids.length };
}

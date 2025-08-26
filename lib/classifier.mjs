// lib/classifier.mjs
// Enhanced classifier with:
// - Cinemeta-first type detection
// - Episode → Parent-Series up-mapping (IMDb scrape)
// - IMDb titleType → bucket mapping (HTML/JSON-LD fallback when Cinemeta is silent)
// - Dedupe and split write
//
// Exported: classifyAndWriteSplit({ uid, lsid, ids, cacheRoot })
//
// Env flags:
//   CINEMETA_BASE
//   CLASSIFY_CONCURRENCY (default 12)
//   EP_PARENT_TTL_MS (default 24h)
//   INCLUDE_MUSIC_VIDEO ("true" to include, default false)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CINEMETA = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY || 12);

const INCLUDE_MUSIC_VIDEO = /^true$/i.test(process.env.INCLUDE_MUSIC_VIDEO || '');

// Episode→Series LRU
const EP_PARENT_LRU = new Map(); // episode -> { parent, ts }
const EP_PARENT_TTL_MS = Number(process.env.EP_PARENT_TTL_MS || 24*60*60*1000);

function lruGetEpParent(tt) {
  const hit = EP_PARENT_LRU.get(tt);
  if (!hit) return null;
  if (Date.now() - hit.ts > EP_PARENT_TTL_MS) { EP_PARENT_LRU.delete(tt); return null; }
  return hit.parent;
}
function lruSetEpParent(tt, parent) {
  if (EP_PARENT_LRU.size > 1000) {
    const toDelete = Math.floor(EP_PARENT_LRU.size * 0.1) || 1;
    let i = 0;
    for (const k of EP_PARENT_LRU.keys()) { EP_PARENT_LRU.delete(k); if (++i >= toDelete) break; }
  }
  EP_PARENT_LRU.set(tt, { parent, ts: Date.now() });
}

async function tryCinemeta(tt, type) {
  const url = `${CINEMETA}/meta/${type}/${tt}.json`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  try {
    const data = await r.json();
    if (data && data.meta && data.meta.id) return data.meta;
  } catch {}
  return null;
}

// ---------------- IMDb HTML helpers ----------------

function mapTitleTypeToBucket(ttype) {
  if (!ttype) return 'unknown';
  const t = String(ttype).toLowerCase();

  // normalize common spellings
  if (t.includes('music video')) return INCLUDE_MUSIC_VIDEO ? 'movie' : 'exclude';
  if (t.includes('video game')) return 'exclude';
  if (t.includes('podcast')) return 'exclude'; // both series + episode

  if (t === 'movie' || t.includes('tv movie') || t.includes('tv special') || t.includes('short') || t.includes('tv short') || t === 'video' || t.includes('video')) {
    // treat all these as "movie" bucket in Stremio
    return 'movie';
  }
  if (t.includes('tv series') || t.includes('tv miniseries') || t.includes('tv mini series') || t.includes('miniseries') || t.includes('mini series')) {
    return 'series';
  }
  if (t.includes('episode')) return 'episode';
  return 'unknown';
}

// Pull JSON-LD blocks
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      if (Array.isArray(json)) blocks.push(...json);
      else blocks.push(json);
    } catch {}
  }
  return blocks;
}

async function fetchImdbHtml(tt) {
  const url = `https://www.imdb.com/title/${tt}/`;
  const r = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
    }
  });
  if (!r.ok) return null;
  return await r.text();
}

async function resolveParentSeriesFromImdb(tt) {
  try {
    const cached = lruGetEpParent(tt);
    if (cached) return cached;

    const html = await fetchImdbHtml(tt);
    if (!html) return null;

    // data-parent-tconst attribute
    let m = html.match(/data-parent-tconst="(tt\d+)"/);
    if (m) { lruSetEpParent(tt, m[1]); return m[1]; }

    // JSON-LD
    const lds = extractJsonLd(html);
    for (const obj of lds) {
      if (!obj) continue;
      if (obj['@type'] === 'TVEpisode' || obj['@type'] === 'Episode') {
        const cand = obj?.partOfSeries?.['@id'] || obj?.partOfSeries?.url
                  || obj?.partOfSeason?.partOfSeries?.['@id'] || obj?.partOfSeason?.partOfSeries?.url
                  || obj?.isPartOf?.['@id'] || obj?.isPartOf?.url;
        if (typeof cand === 'string') {
          const mm = cand.match(/tt\d+/);
          if (mm) { lruSetEpParent(tt, mm[0]); return mm[0]; }
        }
      }
    }

    // Fallback: any /title/tt… found (avoid self)
    m = html.match(/\/title\/(tt\d+)\//);
    if (m && m[1] && m[1] !== tt) { lruSetEpParent(tt, m[1]); return m[1]; }
  } catch {}
  return null;
}

async function resolveTitleTypeFromImdb(tt) {
  try {
    const html = await fetchImdbHtml(tt);
    if (!html) return null;

    // 1) JSON-LD @type
    const lds = extractJsonLd(html);
    for (const obj of lds) {
      if (!obj || !obj['@type']) continue;
      // Normalize into IMDb-ish labels
      const t = String(obj['@type']).toLowerCase();
      if (t === 'movie') return 'movie';
      if (t === 'tvseries') return 'tvSeries';
      if (t === 'tvepisode' || t === 'episode') return 'tvEpisode';
      if (t === 'tvminiseries' || t.includes('miniseries')) return 'tvMiniSeries';
    }

    // 2) Look for explicit titleType label text in the page
    const labelMatch = html.match(/>TV Mini Series<|>TV Series<|>TV Movie<|>TV Special<|>TV Short<|>Short<|>Music Video<|>Video Game<|>Podcast Series<|>Podcast Episode<|>Video/i);
    if (labelMatch) {
      const label = labelMatch[0].replace(/[><]/g, '').trim();
      // convert to a canonical IMDb-like key
      const map = {
        'TV Series': 'tvSeries',
        'TV Mini Series': 'tvMiniSeries',
        'TV Movie': 'tvMovie',
        'TV Special': 'tvSpecial',
        'TV Short': 'tvShort',
        'Short': 'short',
        'Music Video': 'musicVideo',
        'Video Game': 'videoGame',
        'Podcast Series': 'podcastSeries',
        'Podcast Episode': 'podcastEpisode',
        'Video': 'video'
      };
      return map[label] || null;
    }

    return null;
  } catch {}
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
      catch { results[idx] = null; }
      finally { running.delete(p); await run(i++); }
    })();
    running.add(p);
  }
  while (i < Math.min(limit, items.length)) await run(i++);
  await Promise.allSettled([...running]);
  return results;
}

export async function classifyAndWriteSplit({ uid = 'default', lsid, ids = [], cacheRoot }) {
  if (!lsid || !/^ls\d+$/i.test(lsid)) throw new Error('Invalid lsid');
  if (!Array.isArray(ids)) throw new Error('ids must be an array');
  if (!cacheRoot) throw new Error('cacheRoot is required');

  const cacheDir = join(cacheRoot, uid);
  await mkdir(cacheDir, { recursive: true });

  const updatedAt = new Date().toISOString();

  // Persist raw ids for /debug/types
  await writeFile(join(cacheDir, `${lsid}-ids.json`), JSON.stringify({ ids, updatedAt }));

  const results = await pool(ids, CONCURRENCY, async (tt) => {
    // 1) Cinemeta fast path
    const mMeta = await tryCinemeta(tt, 'movie');
    const sMeta = await tryCinemeta(tt, 'series');
    if (mMeta && !sMeta) return { tt, type: 'movie', meta: mMeta };
    if (!mMeta && sMeta) return { tt, type: 'series', meta: sMeta };
    if (mMeta && sMeta) return { tt, type: 'series', meta: sMeta }; // prefer series when ambiguous

    // 2) Episode up-map
    const parent = await resolveParentSeriesFromImdb(tt);
    if (parent && parent !== tt) {
      const pMeta = await tryCinemeta(parent, 'series');
      if (pMeta) return { tt, type: 'series', meta: pMeta, mapped: parent };
    }

    // 3) HTML titleType fallback → bucket
    const ttype = await resolveTitleTypeFromImdb(tt);
    const bucket = mapTitleTypeToBucket(ttype);
    if (bucket === 'movie') {
      const mm = await tryCinemeta(tt, 'movie');
      if (mm) return { tt, type: 'movie', meta: mm };
      return { tt, type: 'exclude', reason: 'movie-no-cinemeta' };
    }
    if (bucket === 'series') {
      const sm = await tryCinemeta(tt, 'series');
      if (sm) return { tt, type: 'series', meta: sm };
      return { tt, type: 'exclude', reason: 'series-no-cinemeta' };
    }
    if (bucket === 'episode') {
      const parent2 = await resolveParentSeriesFromImdb(tt);
      if (parent2 && parent2 !== tt) {
        const s2 = await tryCinemeta(parent2, 'series');
        if (s2) return { tt, type: 'series', meta: s2, mapped: parent2 };
      }
      return { tt, type: 'exclude', reason: 'episode-no-parent' };
    }

    // 4) Heuristic (very soft)
    // If year range like "2015–2017" (Cinemeta releaseInfo might not be present here), skip.
    // Without reliable data, exclude to avoid leaks.
    return { tt, type: 'exclude', reason: 'unknown' };
  });

  const movies = [];
  const seriesArr = [];
  const mappedEpisodes = [];

  for (const r of results) {
    if (!r) continue;
    if (r.type === 'movie' && r.meta) movies.push(toMeta(r.meta, 'movie'));
    else if (r.type === 'series' && r.meta) {
      seriesArr.push(toMeta(r.meta, 'series'));
      if (r.mapped) mappedEpisodes.push({ episode: r.tt, series: r.mapped });
    }
  }

  // Dedupe
  function uniqById(arr) {
    const seen = new Set(), out = [];
    for (const it of arr) { if (!it || !it.id) continue; if (seen.has(it.id)) continue; seen.add(it.id); out.push(it); }
    return out;
  }
  const moviesUniq = uniqById(movies);
  const seriesUniq = uniqById(seriesArr);

  await writeFile(join(cacheDir, `${lsid}-movies.json`), JSON.stringify(moviesUniq));
  await writeFile(join(cacheDir, `${lsid}-series.json`), JSON.stringify(seriesUniq));
  await writeFile(join(cacheDir, `${lsid}-types.json`), JSON.stringify({
    moviesCount: moviesUniq.length,
    seriesCount: seriesUniq.length,
    allIdsCount: ids.length,
    unknownCount: Math.max(0, ids.length - (moviesUniq.length + seriesUniq.length)),
    updatedAt
  }));

  if (mappedEpisodes.length) {
    try {
      await writeFile(join(cacheDir, `${lsid}-episode-map.json`), JSON.stringify({ mappedEpisodes, updatedAt }));
    } catch {}
  }

  return { moviesCount: moviesUniq.length, seriesCount: seriesUniq.length, allIdsCount: ids.length };
}

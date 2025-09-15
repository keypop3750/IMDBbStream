/**
 * IMDbStream — Improved: hide empty type catalogs + genre dropdown (regex fixed)
 * ESM server
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { warmList } from './lib/prefetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Detect Netlify/serverless runtime
const IS_NETLIFY = !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME;


app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------- Config ----------------
const PAGES_MAX = Number(process.env.IMDB_PAGES_MAX || 1);
const TTL_SEC = Number(process.env.IMDB_CACHE_TTL_SEC || 1800);
const CONC = 6;

// ---------------- In-memory caches ----------------
const mem = new Map(); // key -> { v, exp }
const MAX_CACHE_SIZE = 10000; // Prevent memory leaks
const now = () => Date.now();

function getCache(key) {
  const x = mem.get(key);
  if (!x) return null;
  if (x.exp && x.exp < now()) { mem.delete(key); return null; }
  return x.v;
}

function setCache(key, v, ttlSec = TTL_SEC) {
  // Clean up expired entries if cache is getting large
  if (mem.size > MAX_CACHE_SIZE) {
    const cutoff = now();
    for (const [k, entry] of mem.entries()) {
      if (entry.exp && entry.exp < cutoff) {
        mem.delete(k);
      }
    }
  }
  mem.set(key, { v, exp: now() + ttlSec * 1000 });
  return v;
}

// ---------------- Utils ----------------
function htmlDecode(x) {
  return String(x || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Robust HTML → ids + title
function parseImdbListHTML(html) {
  const ids = [];
  const seen = new Set();

  // data-tconst pattern
  let re1 = /data-tconst="(tt\d+)"/gi, m;
  while ((m = re1.exec(html)) !== null) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  // href-based fallback (mobile/stripped)
  let re2 = /\/title\/(tt\d+)\b/gi;
  while ((m = re2.exec(html)) !== null) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  // title
  let title = null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const inner = h1[1].replace(/<[^>]+>/g, '').trim();
    if (inner) title = htmlDecode(inner);
  }
  if (!title) {
    const mt = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (mt) title = htmlDecode(mt[1]).replace(/ - IMDb.*$/,'');
  }
  return { title, ids };
}

// Fetch IMDb list ids with multi-source fallback; cache by lsid
async function fetchImdbIds(lsid) {
  const ck = `ls:${lsid}`;
  const cached = getCache(ck);
  if (cached) return cached;

  let title = null;
  const ids = [];
  const pages = Number(PAGES_MAX) || 1;
  const variants = [
    (p)=>`https://www.imdb.com/list/${lsid}/?st_dt=&mode=detail&page=${p}`,
    (p)=>`https://m.imdb.com/list/${lsid}/?page=${p}`,
    (p)=>`https://r.jina.ai/http://www.imdb.com/list/${lsid}/?st_dt=&mode=detail&page=${p}`,
    (p)=>`https://r.jina.ai/http://m.imdb.com/list/${lsid}/?page=${p}`
  ];

  for (let page = 1; page <= pages; page++) {
    let pageIds = [];
    for (const makeUrl of variants) {
      try {
        const u = makeUrl(page);
        const r = await fetch(u, { headers: {
          'accept': 'text/html,*/*',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'accept-language': 'en,en-GB;q=0.9'
        }});
        if (!r.ok) continue;
        const html = await r.text();
        const parsed = parseImdbListHTML(html);
        if (!title && parsed.title) title = parsed.title;
        pageIds = parsed.ids || [];
        if (pageIds.length) break;
      } catch {}
    }
    if (!pageIds.length) break;
    for (const id of pageIds) if (!ids.includes(id)) ids.push(id);
    if (pageIds.length < 100) break;
  }
  const val = { title: title || `IMDb List ${lsid}`, ids };
  return setCache(ck, val);
}

// Cinemeta typed metas with cache
const CIN_BASE = 'https://v3-cinemeta.strem.io/meta';
async function getMeta(type, tt) {
  const ck = `meta:${type}:${tt}`;
  const c = getCache(ck);
  if (c) return c;
  try {
    const r = await fetch(`${CIN_BASE}/${type}/${tt}.json`, { headers: { 'accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const meta = (j && j.meta) ? j.meta : null;
    if (meta) setCache(ck, meta);
    return meta;
  } catch { return null; }
}

async function getTypedMetaDeterministic(type, tt) {
  // If there is a SERIES meta, it is a series: never show it under movies.
  if (type === 'movie') {
    const s = await getMeta('series', tt);
    if (s) return null;
    return await getMeta('movie', tt);
  } else {
    return await getMeta('series', tt);
  }
}

async function typedPage(type, ids, opts) {
  opts = opts || {};
  const skip  = Math.max(0, parseInt(opts.skip || 0, 10) || 0);
  const limit = Math.max(1, parseInt(opts.limit || 50, 10) || 50);
  const search = String(opts.search || '').toLowerCase().trim();

  // We'll collect metas in index order to preserve IMDb list ordering.
  const slots = new Array(ids.length).fill(null);
  let i = 0;

  async function worker() {
    while (i < ids.length) {
      const my = i++;
      const tt = ids[my];
      const meta = await getTypedMetaDeterministic(type, tt);
      if (!meta) continue;
      if (meta.type && String(meta.type).toLowerCase() !== type) continue;
      if (search && !String(meta.name||'').toLowerCase().includes(search)) continue;
      slots[my] = meta;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, 8) }, () => worker()));

  // Finalize in original order, then apply skip/limit
  const ordered = [];
  for (let k = 0; k < slots.length && ordered.length < (skip + limit); k++) {
    if (slots[k]) ordered.push(slots[k]);
  }
  return ordered;
}

// Quick probe to see if a list has at least one item of a type
async function hasType(lsid, type, sample = 40) { // Reduced sample size from 120 to 40
  const ck = `stats:${lsid}`;
  const stats = getCache(ck) || { movie: null, series: null };
  if (stats[type] !== null) return stats[type] > 0;

  // Check if we have cached files first (much faster)
  const cachedData = await readCacheFile('default', lsid, type);
  if (cachedData && Array.isArray(cachedData) && cachedData.length > 0) {
    stats[type] = 1;
    setCache(ck, stats, 12 * 3600);
    return true;
  }

  // Fallback to API check with smaller sample
  const info = await fetchImdbIds(lsid);
  const ids = info.ids.slice(0, sample);
  let any = false;
  let i = 0;
  async function worker() {
    while (i < ids.length && !any) {
      const tt = ids[i++];
      const meta = await getMeta(type, tt);
      if (meta) { any = true; break; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, 4) }, () => worker()));
  const count = any ? 1 : 0;
  stats[type] = count;
  setCache(ck, stats, 12 * 3600);
  return any;
}

// Update stats after a real page load (more accurate)
function bumpStats(lsid, type, countFound) {
  const ck = `stats:${lsid}`;
  const stats = getCache(ck) || { movie: null, series: null };
  const t = (type === 'movie') ? 'movie' : 'series';
  const prev = stats[t] || 0;
  const next = Math.max(prev, countFound);
  stats[t] = next;
  setCache(ck, stats, 12 * 3600);
}

// ---- Genre canonicalization helpers ----
const DEFAULT_GENRES = [
  'Action','Adventure','Animation','Biography','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror',
  'Music','Musical','Mystery','Romance','Sci-Fi','Sport','Thriller','War','Western'
];

const GENRE_ALIASES = new Map([
  ['sci fi','Sci-Fi'], ['scifi','Sci-Fi'], ['sci-fi','Sci-Fi'], ['science fiction','Sci-Fi'],
  ['doc','Documentary'], ['docs','Documentary'], ['documentaries','Documentary'], ['documentary','Documentary'],
  ['biopic','Biography'], ['bio','Biography'], ['biography','Biography'],
  ['tvmovie','TV Movie'], ['tv movie','TV Movie'],
  ['reality tv','Reality-TV'], ['reality-tv','Reality-TV'],
  ['talk show','Talk-Show'], ['talk-show','Talk-Show'],
  ['game show','Game-Show'], ['game-show','Game-Show'],
  ['kids','Family'], ['children','Family'], ['childrens','Family'],
  ['action & adventure','Action & Adventure'], ['sci-fi & fantasy','Sci-Fi & Fantasy']
]);

const GENRE_EXPANDS = new Map([
  ['Action & Adventure', ['Action','Adventure']],
  ['Sci-Fi & Fantasy', ['Sci-Fi','Fantasy']]
]);

const _normGenre = s => String(s||'').toLowerCase().replace(/[\s._-]+/g, ' ').trim();

function canonicalizeGenre(input) {
  if (!input) return null;
  const key = _normGenre(input);
  const aliased = GENRE_ALIASES.get(key);
  if (aliased) return aliased;
  const words = key.split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1)) : w).join(' ');
  if (words === 'Sci Fi') return 'Sci-Fi';
  return words;
}

function explodeToCanonicalSet(raw) {
  if (!raw) return new Set();
  const parts = Array.isArray(raw) ? raw.slice() : String(raw).split(/[,&/]| and /i);
  const canon = new Set();
  for (const p of parts) {
    const c = canonicalizeGenre(p);
    if (!c) continue;
    const expand = GENRE_EXPANDS.get(c);
    if (expand) expand.forEach(x => canon.add(x));
    else canon.add(c);
  }
  return canon;
}

function readExtras(req) {
  const extras = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
  const segs = req.path.split('/').filter(Boolean);
  const idx = segs.findIndex(s => s === 'catalog');
  if (idx >= 0 && segs.length > idx + 3) {
    const tail = segs.slice(idx + 3);
    for (let i = 0; i < tail.length; i += 2) {
      const k = tail[i];
      let v = tail[i+1] || '';
      v = v.replace(/\.json$/i, '');
      if (k && v) extras[k] = decodeURIComponent(v);
    }
  }
  return extras;
}

// Extract 'genre' robustly from query OR path (/genre/<g>.json)
function getGenreFromReq(req) {
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const qg = qs.get('genre');
  if (qg) return decodeURIComponent(qg);
  const m = (req.path || '').match(/\/genre\/([^/]+)\.json$/i);
  return m ? decodeURIComponent(m[1]) : '';
}

// Parse Stremio-style extras passed as the last path component (like the tmdb addon)
function parseExtrasFromParam(req) {
  try {
    const last = req.url.split('/').pop().split('?')[0].replace(/\.json$/i,'');
    const pairs = new URLSearchParams(last);
    return Object.fromEntries(pairs.entries());
  } catch { return {}; }
}

// ---------------- Static UI ----------------

// Tolerate clients that append /configure to the manifest URL


// ---- BEGIN: helper: default genres + listGenresForType (fallback) ----
const DEFAULT_MOVIE_GENRES = [
  'Action','Adventure','Animation','Biography','Comedy','Crime','Documentary',
  'Drama','Family','Fantasy','History','Horror','Music','Musical','Mystery',
  'Romance','Sci-Fi','Sport','Thriller','War','Western'
];

const DEFAULT_SERIES_GENRES = [
  'Action','Adventure','Animation','Biography','Comedy','Crime','Documentary',
  'Drama','Family','Fantasy','History','Horror','Music','Mystery',
  'Romance','Sci-Fi','Sport','Thriller','War','Western'
];

/**
 * Returns the allowed genres for a given imdb list and type.
 * If you don't have a per-list cache, we just return a broad default.
 * Keeping it async so existing call sites remain unchanged.
 */
async function listGenresForType(lsid, type) {
  return type === 'series' ? DEFAULT_SERIES_GENRES : DEFAULT_MOVIE_GENRES;
}
// ---- END: helper: default genres + listGenresForType (fallback) ----

// ---- BEGIN: helper: build proper Stremio deep links and web links ----
function buildInstallUrls(req, uidRaw) {
  const uid = String(uidRaw ?? (req.query.uid || (req.cookies ? req.cookies.uid : '') || 'default'));
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host'));
  const base = `${proto}://${host}`;
  const manifestUrl = `${base}/manifest.json?uid=${encodeURIComponent(uid)}`;
  const deepLink = `stremio:///install-addon?addon=${encodeURIComponent(manifestUrl)}`;
  const webLink = `https://web.stremio.com/#/addons?addonUrl=${encodeURIComponent(manifestUrl)}`;
  return { uid, manifestUrl, deepLink, webLink };
}
// Expose a debug endpoint so the frontend can fetch correct links (helps with localhost vs render.com)
app.get('/debug/install-url', (req, res) => {
  const { uid, manifestUrl, deepLink, webLink } = buildInstallUrls(req, req.query.uid);
  res.set('Cache-Control','no-store');
  res.json({ uid, manifestUrl, deepLink, webLink });
});
// Minimal HTML endpoint that triggers the OS deep-link to Stremio
app.get('/install', (req, res) => {
  const { uid, manifestUrl, deepLink } = buildInstallUrls(req, req.query.uid);
  res.set('Cache-Control','no-store');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${deepLink}">
            <p><a href="${deepLink}">Open in Stremio</a></p>
            <p>If nothing happens, copy this URL into Stremio: <code>${manifestUrl}</code></p>`);
});
// ---- END: helper: build proper Stremio deep links and web links ----

app.get('/manifest.json/configure', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/configure' + qs);
});

const uiDir = path.join(__dirname, 'public', 'ui');
if (!IS_NETLIFY) app.use('/ui', express.static(uiDir));
if (!IS_NETLIFY) app.use(express.static(uiDir));

// --- uid helper via query or cookie (fallback to 'default')
function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach(p => {
    const idx = p.indexOf('=');
    if (idx > -1) out[p.slice(0,idx).trim()] = decodeURIComponent(p.slice(idx+1));
  });
  return out;
}
function getUidFromReq(req) {
  const q = req.query && (req.query.uid || req.query.user || req.query.u);
  if (q) return String(q);
  const c = parseCookies(req);
  return c.uid || 'default';
}
function setUidCookie(res, uid) {
  try { res.setHeader('Set-Cookie', `uid=${encodeURIComponent(uid)}; Path=/; Max-Age=31536000; SameSite=Lax`); } catch {}
}

app.get('/configure', (req, res) => {
  const uid = getUidFromReq(req);
  setUidCookie(res, uid);
  res.set('Cache-Control','no-store');
  if (IS_NETLIFY) {
    // On Netlify functions, serve static UI via Netlify and just redirect
    return res.redirect(302, '/ui/index.html');
  }
  return res.sendFile(path.join(uiDir, 'index.html'));
});
app.get(['/model2.js','/ui/model2.js'], (req, res) => res.sendFile(path.join(uiDir, 'model2.js')));

// ---------------- Simple per-user store (default uid="default") ----------------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

function _loadUsersObj() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}
function _saveUsersObj(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2));
}

const users = new Map(Object.entries(_loadUsersObj()));

function _saveNow() {
  const obj = {};
  for (const [k, v] of users.entries()) obj[k] = v;
  _saveUsersObj(obj);
}

function getUser(uid='default') {
  if (!users.has(uid)) users.set(uid, { uid, lists: [] });
  return users.get(uid);
}

// Helper function to extract actual genres from cached data
function getActualGenres(items) {
  const genreSet = new Set();
  
  for (const item of items) {
    if (item.genres && Array.isArray(item.genres)) {
      for (const genre of item.genres) {
        genreSet.add(genre);
      }
    }
  }
  
  // Sort genres alphabetically
  const actualGenres = Array.from(genreSet).sort();
  
  // Return empty array if no genres found
  return actualGenres.length > 0 ? actualGenres : [];
}

// ---------------- Manifest ----------------
app.get('/manifest.json', async (req, res) => {
  const uid = String(new URLSearchParams(req.url.split('?')[1] || '').get('uid') || 'default');
  
  // For v2 rollout, disable manifest caching temporarily
  // const manifestCacheKey = `manifest:${uid}`;
  // const cachedManifest = getCache(manifestCacheKey);
  // if (cachedManifest) {
  //   res.set('Cache-Control', 'public, max-age=300'); // Cache on client too
  //   return res.json(cachedManifest);
  // }

  const u = getUser(uid);
  
  // If no lists, return empty manifest immediately
  if (!u.lists || u.lists.length === 0) {
    const emptyManifest = {
      id: 'com.imdbstream.enhanced.v2',
      version: '2.1.0',
      name: 'IMDbStream Enhanced',
      description: 'IMDb list splitter with Cast & Directors metadata',
      resources: ['catalog', 'meta'],
      types: ['movie','series'],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false }
    };
    // setCache(manifestCacheKey, emptyManifest, 300);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.json(emptyManifest);
  }

  const catalogs = [];

  // Process all lists in parallel for faster manifest generation
  const listPromises = (u.lists || []).map(async (l) => {
    const lsid = l.id || l.lsid || l;
    const name = l.name || `IMDb List ${lsid}`;

    // Run hasType checks in parallel
    const [hasMovies, hasSeries] = await Promise.all([
      hasType(lsid, 'movie'),
      hasType(lsid, 'series')
    ]);

    const catalogsForList = [];

    if (hasMovies) {
      // Get actual genres from cached movies
      const cachedMovies = await readCacheFile(uid, lsid, 'movie');
      const actualMovieGenres = getActualGenres(cachedMovies || []);
      
      catalogsForList.push({
        id: `imdb-${uid}-${lsid}-movies-v2`,
        type: 'movie',
        name: name,
        extra: [
          { name: 'search' },
          { name: 'skip' },
          { name: 'limit' },
          { name: 'genre', options: actualMovieGenres },
          { name: 'Sort', options: ['Added','Name','Year','Rating','Runtime'] },
          { name: 'Order', options: ['asc','desc'] }
        ],
        genres: actualMovieGenres
      });
    }
    if (hasSeries) {
      // Get actual genres from cached series
      const cachedSeries = await readCacheFile(uid, lsid, 'series');
      const actualSeriesGenres = getActualGenres(cachedSeries || []);
      
      catalogsForList.push({
        id: `imdb-${uid}-${lsid}-series-v2`,
        type: 'series',
        name: name,
        extra: [
          { name: 'search' },
          { name: 'skip' },
          { name: 'limit' },
          { name: 'genre', options: actualSeriesGenres },
          { name: 'Sort', options: ['Added','Name','Year','Rating','Runtime'] },
          { name: 'Order', options: ['asc','desc'] }
        ],
        genres: actualSeriesGenres
      });
    }

    return catalogsForList;
  });

  // Wait for all lists to be processed
  const allCatalogArrays = await Promise.all(listPromises);
  
  // Flatten the arrays
  for (const catalogArray of allCatalogArrays) {
    catalogs.push(...catalogArray);
  }

  const manifest = {
    id: 'com.imdbstream.enhanced.v2',
    version: '2.0.0',
    name: 'IMDbStream Enhanced',
    description: 'IMDb list splitter with Cast & Directors metadata',
    resources: ['catalog', 'meta'],
    types: ['movie','series'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  };

  // For v2 rollout, disable manifest caching temporarily
  // setCache(manifestCacheKey, manifest, 300);
  
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(manifest);
});

// ---------------- File Cache Helper ----------------
function getCachePath(uid, lsid, type) {
  return path.join(__dirname, 'data', 'cache', uid, `${lsid}-${type === 'movie' ? 'movies' : 'series'}.json`);
}

async function readCacheFile(uid, lsid, type) {
  try {
    const cachePath = getCachePath(uid, lsid, type);
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------- Catalog ----------------
function sortMetas(arr, sortKey, order) {
  const dir = String(order||'asc').toLowerCase()==='desc' ? -1 : 1;
  // Normalize sort key to lowercase for comparison
  const normalizedSort = String(sortKey||'').toLowerCase();
  if (normalizedSort==='added' || normalizedSort==='date' || normalizedSort==='dateadded') {
    return dir === -1 ? [...arr].reverse() : [...arr];
  }
  const get = (m) => {
    switch (normalizedSort) {
      case 'year': return Number(m.year || 0);
      case 'rating': return Number((m.rating && m.rating.imdb) || m.imdbRating || 0);
      case 'runtime': return Number(m.runtime || 0);
      case 'name':
      case 'title':
      case 'alphabetical': default: return String(m.name || '').toLowerCase();
    }
  };
  return [...arr].sort((a,b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * dir);
}

// ---------------- Meta ----------------
async function handleMeta(req, res) {
  const uid = getUidFromReq(req); setUidCookie(res, uid);
  try {
    const { type, id } = req.params;
    if (!['movie','series'].includes(type)) return res.status(404).json({ meta: null });
    if (!id || !id.startsWith('tt')) return res.status(404).json({ meta: null });

    // First check if this item exists in any of our cached lists
    const u = getUser(uid);
    let foundMeta = null;
    
    // Search through all user's lists to find this item
    for (const list of (u.lists || [])) {
      const lsid = list.id || list.lsid || list;
      const cachedData = await readCacheFile(uid, lsid, type);
      if (cachedData && Array.isArray(cachedData)) {
        const found = cachedData.find(item => item.id === id);
        if (found) {
          foundMeta = found;
          break;
        }
      }
    }

    // If not found in our cache, fall back to Cinemeta
    if (!foundMeta) {
      const cinemeta = await getMeta(type, id);
      if (!cinemeta) return res.status(404).json({ meta: null });
      foundMeta = cinemeta;
    }

    // Force no cache for enhanced metadata
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.json({ meta: foundMeta });
  } catch (e) {
    console.error('Meta error', e);
    res.status(500).json({ meta: null });
  }
}

async function handleCatalog(req, res) {
  const uid = getUidFromReq(req); setUidCookie(res, uid);
  try {
    const { type, catalogId } = req.params;
    if (!['movie','series'].includes(type)) return res.json({ metas: [] });
    const m = catalogId.match(/^imdb-(.+?)-(ls\d+)-(movies|series)(?:-v\d+)?$/i);
    if (!m) return res.json({ metas: [] });
    const uidFromId = m[1];
    const lsid = m[2].toLowerCase();

    const extras = { ...parseExtrasFromParam(req), ...readExtras(req) };
    const skip = Math.max(0, parseInt(extras.skip || '0', 10) || 0);
    const limit = Math.max(1, Math.min(80, parseInt(extras.limit || '50', 10) || 50));
    const search = String(extras.search || '').trim();
    const genreRaw = extras.genre || getGenreFromReq(req) || '';

    // Try to use cached file first
    let metas = await readCacheFile(uidFromId, lsid, type);
    
    if (!metas || !Array.isArray(metas)) {
      // Fallback to real-time processing
      console.log(`Cache miss for ${lsid}-${type}, falling back to real-time processing`);
      const info = await fetchImdbIds(lsid);
      const ids = info.ids || [];
      metas = await typedPage(type, ids, { skip: 0, limit: Math.max(limit + skip, 80), search });
    }

    // Apply search filter if needed
    if (search && search.length > 0) {
      metas = metas.filter(meta => 
        String(meta.name || '').toLowerCase().includes(search.toLowerCase())
      );
    }

    // Apply genre filter if needed
    if (genreRaw) {
      const wantedCanon = canonicalizeGenre(genreRaw);
      const wantedSet = new Set(GENRE_EXPANDS.get(wantedCanon) || [wantedCanon]);
      metas = metas.filter(meta => {
        const metaSet = explodeToCanonicalSet(meta.genres || meta.genre);
        for (const w of wantedSet) if (metaSet.has(w)) return true;
        return false;
      });
    }

    const sort = extras.sort || extras.Sort || null;
    const order = extras.order || extras.Order || 'asc';
    if (sort) metas = sortMetas(metas, sort, order);

    metas = metas.slice(skip, skip + limit);

    if (metas && metas.length) bumpStats(lsid, type, metas.length);

    // Force fresh data for v2 enhanced metadata - no cache initially
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('ETag', `"v2-${lsid}-${type}-${Date.now()}"`); // Unique ETag for each request
    
    res.json({ metas });
  } catch (e) {
    console.error('Catalog error', e);
    res.json({ metas: [] });
  }
}

// Meta endpoints
app.get('/meta/:type/:id.json', handleMeta);

app.get('/catalog/:type/:catalogId.json', handleCatalog);
app.get('/catalog/:type/:catalogId/:extra?.json', handleCatalog);
app.get('/catalog/:type/:catalogId/*', handleCatalog);

// ---------------- Minimal configure API ----------------
app.get('/api/user/:uid/lists', (req, res) => {
  const uid = String(req.params.uid || 'default');
  res.json(getUser(uid).lists || []);
});

// Preload endpoint - starts cache warming for all lists
app.post('/api/user/:uid/preload', async (req, res) => {
  const uid = String(req.params.uid || 'default');
  const u = getUser(uid);
  
  if (!u.lists || u.lists.length === 0) {
    return res.json({ message: 'No lists to preload' });
  }

  // Start warming all lists in background (don't wait)
  const promises = u.lists.map(async (list) => {
    const lsid = list.id || list.lsid || list;
    try {
      return await warmList(uid, lsid, { 
        origin: process.env.PUBLIC_BASE || `http://localhost:${PORT || 7000}` 
      });
    } catch (err) {
      console.log(`Preload failed for ${lsid}:`, err.message);
      return { ok: false, lsid, error: err.message };
    }
  });

  // Don't wait for completion, return immediately
  res.json({ message: `Started preloading ${u.lists.length} lists`, lists: u.lists.length });
  
  // Log results when done
  Promise.all(promises).then(results => {
    const success = results.filter(r => r.ok).length;
    console.log(`✅ Preload completed: ${success}/${results.length} lists cached`);
  });
});

app.post('/api/user/:uid/lists', async (req, res) => {
  try {
    const uid = String(req.params.uid || 'default');
    const u = getUser(uid);
    const srcRaw = (req.body && req.body.src) ? String(req.body.src).trim() : '';
    if (!srcRaw) return res.status(400).json({ error: 'Missing src' });
    const m = srcRaw.match(/ls\d{6,}/i);
    const lsid = (m ? m[0] : srcRaw).toLowerCase();
    if (!/^ls\d{6,}$/i.test(lsid)) return res.status(400).json({ error: 'Invalid IMDb list id or URL' });
    let title = `IMDb List ${lsid}`;
    try { const info = await fetchImdbIds(lsid); title = info.title || title; } catch {}
    const exists = (u.lists || []).some(x => (x.id || x.lsid || x) === lsid);
    if (!exists) u.lists = [...(u.lists || []), { id: lsid, name: title, showIn: 'discover' }];
    else u.lists = u.lists.map(x => ((x.id||x)===lsid ? { ...(typeof x==='object'?x:{id:lsid}), name: title } : x));
    res.json({ id: lsid });
    _saveNow();
    
    // Auto-warm cache for new list
    console.log(`🔥 Auto-warming cache for new list: ${title} (${lsid})`);
    warmList(uid, lsid, { 
      origin: process.env.PUBLIC_BASE || `http://localhost:${PORT || 7000}` 
    }).then(result => {
      if (result.ok) {
        console.log(`✅ Cache warmed: ${result.counts.movies} movies, ${result.counts.series} series`);
      } else {
        console.log(`❌ Cache warming failed for ${lsid}`);
      }
    }).catch(err => {
      console.log(`❌ Cache warming error for ${lsid}:`, err.message);
    });
  } catch (e) { res.status(500).json({ error: 'Failed to add list' }); }
});

app.patch('/api/user/:uid/lists/:lsid', (req, res) => {
  const uid = String(req.params.uid || 'default');
  const lsid = String(req.params.lsid);
  const { showIn } = req.body || {};
  const u = getUser(uid);
  u.lists = (u.lists || []).map(x => ( (x.id||x)===lsid ? { ...(typeof x==='object'?x:{id:lsid}), showIn: (showIn||x.showIn||'discover') } : x ));
  res.json({ ok: true });
  _saveNow();
});

app.delete('/api/user/:uid/lists/:lsid', (req, res) => {
  const uid = String(req.params.uid || 'default');
  const lsid = String(req.params.lsid);
  const u = getUser(uid);
  u.lists = (u.lists || []).filter(x => (x.id || x) !== lsid);
  res.json({ ok: true });
  _saveNow();
});

// ---------------- Start ----------------
// ---------------- Start ----------------
const PORT = process.env.PORT || 7000;
if (!IS_NETLIFY) {
  app.listen(PORT, () => {
    console.log(`IMDbStream server running on http://localhost:${PORT}`);
    console.log(`Configure at: http://localhost:${PORT}/configure?uid=default`);
  });
}

export default app;

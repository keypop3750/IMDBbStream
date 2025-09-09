
/**
 * IMDbStream — Improved: hide empty type catalogs + genre dropdown (regex fixed)
 * ESM server
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------- Config ----------------
const PAGES_MAX = Number(process.env.IMDB_PAGES_MAX || 1);
const TTL_SEC = Number(process.env.IMDB_CACHE_TTL_SEC || 1800);
const CONC = 6;

// ---------------- In-memory caches ----------------
const mem = new Map(); // key -> { v, exp }
const now = () => Date.now();
function getCache(key) {
  const x = mem.get(key);
  if (!x) return null;
  if (x.exp && x.exp < now()) { mem.delete(key); return null; }
  return x.v;
}
function setCache(key, v, ttlSec = TTL_SEC) {
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
async function hasType(lsid, type, sample = 120) {
  const ck = `stats:${lsid}`;
  const stats = getCache(ck) || { movie: null, series: null };
  if (stats[type] !== null) return stats[type] > 0;

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

async function listGenresForType(lsid, type) {
  const ck = `genres:${lsid}:${type}`;
  const cached = getCache(ck);
  if (cached) return cached;

  const info = await fetchImdbIds(lsid);
  const ids = info.ids || [];
  const have = new Set();

  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const idx = i++;
      const tt = ids[idx];
      const meta = await getTypedMetaDeterministic(type, tt);
      if (!meta) continue;
      const s = explodeToCanonicalSet(meta.genres || meta.genre);
      for (const g of s) if (DEFAULT_GENRES.includes(g)) have.add(g);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, 6) }, worker));

  const arr = DEFAULT_GENRES.filter(g => have.has(g));
  setCache(ck, arr, 6 * 3600);
  return arr;
}

// ---------------- Static UI ----------------

// Tolerate clients that append /configure to the manifest URL
app.get('/manifest.json/configure', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/configure' + qs);
});

const uiDir = path.join(__dirname, 'public', 'ui');
app.use('/ui', express.static(uiDir));
app.use(express.static(uiDir));
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
  res.sendFile(path.join(uiDir, 'index.html'));
});
app.get(['/model2.js','/ui/model2.js'], (req, res) => res.sendFile(path.join(uiDir, 'model2.js')));

// ---------------- Simple per-user store (default uid="default") ----------------
import fs from 'fs';

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

function visibilityFor(list) {
  const v = (list && list.visibility) || {};
  const showIn = String(list && list.showIn || '').toLowerCase(); // legacy
  function side(s) {
    const vv = v[s] || {};
    const discover = (vv.discover !== undefined) ? !!vv.discover : (/discover|both/.test(showIn) || showIn === '');
    const home     = (vv.home     !== undefined) ? !!vv.home     : (/home|both/.test(showIn));
    return { discover, home };
  }
  return { movie: side('movie'), series: side('series') };
}
// ---------------- Manifest ----------------
const DEFAULT_GENRES = [
  'Action','Adventure','Animation','Biography','Comedy','Crime','Documentary','Drama','Family','Fantasy','History','Horror',
  'Music','Musical','Mystery','Romance','Sci-Fi','Sport','Thriller','War','Western'
];
 // ---- Genre canonicalization helpers ----
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
app.get('/manifest.json', async (req, res) => {
  const uid = String(new URLSearchParams(req.url.split('?')[1] || '').get('uid') || 'default');
  const u = getUser(uid);
  const catalogs = [];

  for (const l of (u.lists || [])) {
    const lsid = l.id || l.lsid || l;
    const name = l.name || `IMDb List ${lsid}`;

    // Only include a type if we believe it has items
    const hasMovies = await hasType(lsid, 'movie');
    const hasSeries = await hasType(lsid, 'series');

    
    const vis = visibilityFor(l);

    if (hasMovies && (vis.movie.discover || vis.movie.home)) {
      const movieGenres = await listGenresForType(lsid, 'movie');
      catalogs.push({
        id: `imdb-${uid}-${lsid}-movies`,
        type: 'movie',
        name,
        extra: [
          { name:'search' },
          { name:'skip' },
          { name:'limit' },
          { name:'sort', options:['added','name','year','rating','runtime'] },
          { name:'order', options:['asc','desc'] },
          { name:'genre', options: movieGenres, isRequired: !vis.movie.home }
        ],
        genres: movieGenres
      });
    }

    
    if (hasSeries && (vis.series.discover || vis.series.home)) {
      const seriesGenres = await listGenresForType(lsid, 'series');
      catalogs.push({
        id: `imdb-${uid}-${lsid}-series`,
        type: 'series',
        name,
        extra: [
          { name:'search' },
          { name:'skip' },
          { name:'limit' },
          { name:'sort', options:['added','name','year','rating','runtime'] },
          { name:'order', options:['asc','desc'] },
          { name:'genre', options: seriesGenres, isRequired: !vis.series.home }
        ],
        genres: seriesGenres
      });
    }

  }

  res.json({
    id: 'com.imdbstream.local',
    version: '1.3.1',
    name: 'IMDbStream',
    description: 'IMDb list splitter (Movies/Series) with genre filter',
    resources: ['catalog'],
    types: ['movie','series'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  });
});

// ---- Sort normalization helpers ----
function normalizeSortKey(k) {
  const sk = String(k || '').toLowerCase();
  if (!sk) return '';
  if (['alpha','alphabetical','title','name'].includes(sk)) return 'name';
  if (['year','date','released'].includes(sk)) return 'year';
  if (['imdb','score','rating','vote','votes','popularity','popular','trending','hot'].includes(sk)) return 'rating';
  if (['runtime','duration','length'].includes(sk)) return 'runtime';
  if (['added','recent','new','updated'].includes(sk)) return 'added';
  return sk;
}
function normalizeOrder(v) {
  const ov = String(v || 'asc').toLowerCase();
  if (['-1','desc','descending','reverse','rev'].includes(ov)) return 'desc';
  return 'asc';
}
// ---------------- Catalog ----------------

function sortMetas(arr, sortKey, order) {
  const key = String(sortKey || '').toLowerCase();
  const dir = (String(order || 'asc').toLowerCase() === 'desc') ? -1 : 1;
  const strip = (s='') => String(s).replace(/^(the|a|an)\s+/i,'').toLowerCase().trim();
  const toNum = (x) => {
    if (x == null) return 0;
    if (typeof x === 'number') return isFinite(x) ? x : 0;
    const m = String(x).match(/[\d.]+/);
    return m ? Number(m[0]) : 0;
  };
  const getYear = m => toNum(m.year || (m.releaseInfo && m.releaseInfo.slice(0,4)));
  const getRating = m => toNum((m.rating && (m.rating.imdb || m.rating)) || m.imdbRating || m.imdb_rating);
  const getRuntime = m => toNum(m.runtimeMinutes || m.runtime); // handles "101 min"
  if (key === 'added' || key === '') {
    return dir === -1 ? [...arr].reverse() : [...arr];
  }
  let getter;
  switch (key) {
    case 'year': getter = getYear; break;
    case 'rating': getter = getRating; break;
    case 'runtime': getter = getRuntime; break;
    case 'name':
    case 'title':
    case 'alphabetical':
    default: getter = (m) => strip(m.name || ''); break;
  }
  return [...arr]
    .map((m,i) => [m,i])
    .sort((A,B) => {
      const a = getter(A[0]), b = getter(B[0]);
      const d = (a > b) - (a < b);
      return d !== 0 ? d * dir : (A[1] - B[1]);
    })
    .map(x => x[0]);
}

async function handleCatalog(req, res) {
  const uid = getUidFromReq(req); setUidCookie(res, uid);
  try {
    const { type, catalogId } = req.params;
    if (!['movie','series'].includes(type)) return res.json({ metas: [] });
    const m = catalogId.match(/^imdb-(.+?)-(ls\d+)-(movies|series)$/i);
    if (!m) return res.json({ metas: [] });
    const uidFromId = m[1];
    const lsid = m[2].toLowerCase();

    const extras = { ...parseExtrasFromParam(req), ...readExtras(req) };
    const skip = Math.max(0, parseInt(extras.skip || '0', 10) || 0);
    const limit = Math.max(1, Math.min(80, parseInt(extras.limit || '50', 10) || 50));
    const search = String(extras.search || '').trim();
    const genreRaw = extras.genre || getGenreFromReq(req) || '';
    // Apply per-list default sort when client doesn't specify sort/order
    try {
      const uDef = getUser(uidFromId);
      const entryDef = (uDef.lists || []).find(x => (x.id || x) === lsid) || {};
      const ds = entryDef.defaultSort || {};
      if (!extras.sort && ds.key) {
        extras.sort = normalizeSortKey(ds.key);
      }
      if (!extras.order && ds.order) {
        extras.order = normalizeOrder(ds.order);
      }
    } catch {}

    // Ghosting: if this catalog is Home-only (home=true, discover=false), return empty for non-Top queries (Discover)
    let __isHomeOnly = false;
    try {
      const uidX = uidFromId;
      const uX = getUser(uidX);
      const entryX = (uX.lists || []).find(x => (x.id || x) === lsid) || {};
      const visX = visibilityFor(entryX);
      const tVisX = (type === 'movie') ? visX.movie : visX.series;
      __isHomeOnly = !!(tVisX && tVisX.home && !tVisX.discover);
    } catch {}
    if (__isHomeOnly) {
      const gcanon = String(genreRaw || 'Top').toLowerCase();
      const hasSearch = !!(extras.search && String(extras.search).trim());
      if (gcanon !== 'top' || hasSearch) {
        return res.json({ metas: [] });
      }
    }

    const info = await fetchImdbIds(lsid);
    const ids = info.ids || [];

    let metas = await typedPage(type, ids, { skip: 0, limit: Math.max(limit + skip, 80), search });

    if (genreRaw) {
      const wantedCanon = canonicalizeGenre(genreRaw);
      const wantedSet = new Set(GENRE_EXPANDS.get(wantedCanon) || [wantedCanon]);
      metas = metas.filter(meta => {
        const metaSet = explodeToCanonicalSet(meta.genres || meta.genre);
        for (const w of wantedSet) if (metaSet.has(w)) return true;
        return false;
      });
    }

    let sort = extras.sort ? normalizeSortKey(extras.sort) : null;
    
    let order = normalizeOrder(extras.order || 'asc');
    if (sort) metas = sortMetas(metas, sort, order);

    metas = metas.slice(skip, skip + limit);

    if (metas && metas.length) bumpStats(lsid, type, metas.length);

    res.json({ metas });
  } catch (e) {
    console.error('Catalog error', e);
    res.json({ metas: [] });
  }
}
app.get('/catalog/:type/:catalogId.json', handleCatalog);
app.get('/catalog/:type/:catalogId/:extra?.json', handleCatalog);
app.get('/catalog/:type/:catalogId/*', handleCatalog);

// ---------------- Minimal configure API ----------------
app.get('/api/user/:uid/lists', (req, res) => {
  const uid = String(req.params.uid || 'default');
  res.json(getUser(uid).lists || []);
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
  } catch (e) { res.status(500).json({ error: 'Failed to add list' }); }
});

app.patch('/api/user/:uid/lists/:lsid', (req, res) => {
  const uid = String(req.params.uid || 'default');
  const lsid = String(req.params.lsid);
  const { showIn, visibility, name, defaultSort } = req.body || {};
  const u = getUser(uid);
  const next = [];
  let found = false;
  for (const x of (u.lists || [])) {
    const xid = (x.id || x.lsid || x);
    if (xid === lsid) {
      found = true;
      const obj = (typeof x === 'object') ? { ...x } : { id: lsid };
      if (typeof name === 'string' && name.trim()) obj.name = name.trim();
      if (showIn) obj.showIn = String(showIn);
      if (visibility && typeof visibility === 'object') {
        const mv = (visibility.movie  || {});
        const sv = (visibility.series || {});
        obj.visibility = {
          movie: {
            discover: mv.discover !== undefined ? !!mv.discover : ((obj.visibility && obj.visibility.movie && obj.visibility.movie.discover) ?? (obj.showIn ? /discover|both/i.test(obj.showIn) : true)),
            home:     mv.home     !== undefined ? !!mv.home     : ((obj.visibility && obj.visibility.movie && obj.visibility.movie.home)     ?? (obj.showIn ? /home|both/i.test(obj.showIn) : false))
          },
          series: {
            discover: sv.discover !== undefined ? !!sv.discover : ((obj.visibility && obj.visibility.series && obj.visibility.series.discover) ?? (obj.showIn ? /discover|both/i.test(obj.showIn) : true)),
            home:     sv.home     !== undefined ? !!sv.home     : ((obj.visibility && obj.visibility.series && obj.visibility.series.home)     ?? (obj.showIn ? /home|both/i.test(obj.showIn) : false))
          }
        };
      }
      
      if (defaultSort && typeof defaultSort === 'object') {
        const k = normalizeSortKey(defaultSort.key);
        const o = normalizeOrder(defaultSort.order);
        obj.defaultSort = {};
        if (k) obj.defaultSort.key = k;
        if (o) obj.defaultSort.order = o;
      }
      next.push(obj);
    } else {
      next.push(x);
    }
  }
  if (!found) { const obj = { id: lsid };
    if (defaultSort && typeof defaultSort === 'object') {
      const k = normalizeSortKey(defaultSort.key);
      const o = normalizeOrder(defaultSort.order);
      obj.defaultSort = {};
      if (k) obj.defaultSort.key = k;
      if (o) obj.defaultSort.order = o;
    }
if (typeof name === 'string' && name.trim()) obj.name = name.trim();
    if (showIn) obj.showIn = String(showIn);
    if (visibility && typeof visibility === 'object') obj.visibility = visibility;
    u.lists = [...(u.lists || []), obj];
  } else {
    u.lists = next;
  }
  _saveNow();
  res.json({ ok: true });
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
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`IMDbStream server running on http://localhost:${PORT}`);
  console.log(`Configure at: http://localhost:${PORT}/configure?uid=default`);
});

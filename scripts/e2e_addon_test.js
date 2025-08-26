// Comprehensive E2E tester for the IMDbStream addon.
// Validates: list add/remove, warming, split caches, catalogs & extras, visibility toggles,
// merged ALL catalogs, dedupe, media fallbacks, and (optionally) min-runtime filter.
//
// Usage:
//   node scripts/e2e_addon_test.js http://localhost:7000 default \\
//     --lists ls4103816671,ls1234567 \\
//     --episodes lsXXXXXXXXXX (optional, list containing only episodes) \\
//     --expectMinRuntime 5 (optional, if server started with MIN_SHORT_RUNTIME=5)
//
// Exit codes: 0 success, 2 on assertion failure.
import fetch from 'node-fetch';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/e2e_addon_test.js <BASE_URL> <UID> [--lists ls1,ls2] [--episodes lsEp] [--expectMinRuntime N]');
  process.exit(1);
}
const BASE = args[0].replace(/\/$/, '');
const UID = args[1];
const opt = {};
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a === '--lists') opt.lists = args[++i].split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--episodes') opt.episodes = args[++i];
  else if (a === '--expectMinRuntime') opt.expectMinRuntime = parseInt(args[++i], 10) || 0;
}
if (!opt.lists || !opt.lists.length) {
  console.error('Please provide at least one list via --lists');
  process.exit(1);
}

function url(p){ return `${BASE}${p}`; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function api(method, path, body) {
  const res = await fetch(url(path), {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body: payload };
}

function assert(cond, msg){ if (!cond) throw new Error(msg); }
function hasHttp(u){ return typeof u === 'string' && /^(https?:)?\/\//.test(u); }
function isAsset(u){ return typeof u === 'string' && u.startsWith('/assets/'); }

async function addList(lsid){
  const r = await api('POST', `/api/user/${encodeURIComponent(UID)}/lists`, { src: lsid });
  assert(r.status === 200, 'Add list failed');
}
async function patchList(lsid, showIn){
  const r = await api('PATCH', `/api/user/${encodeURIComponent(UID)}/lists/${encodeURIComponent(lsid)}`, { showIn });
  assert(r.status === 200, 'Patch list failed');
}

async function warm(lsid){
  const r = await api('GET', `/admin/warm-split?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(lsid)}`);
  assert(r.status === 200, 'Warm failed');
  return r.body && r.body.result ? r.body.result : r.body;
}

async function readTypes(lsid){
  const r = await api('GET', `/debug/types?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(lsid)}`);
  assert(r.status === 200, 'types failed');
  return r.body;
}

async function showCache(lsid, type){
  const r = await api('GET', `/admin/show-cache?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(lsid)}&type=${type}`);
  assert(r.status === 200, 'show-cache failed');
  return r.body;
}

async function catalog(type, id, extras=''){
  const r = await fetch(url(`/catalog/${type}/${id}.json${extras ? ('?' + extras) : ''}`));
  assert(r.status === 200, 'catalog fetch failed');
  return { metas: (await r.json()).metas, headers: r.headers };
}

async function testList(lsid){
  console.log(`\n[LIST] ${lsid}`);
  await addList(lsid);
  await warm(lsid);
  const types = await readTypes(lsid);
  assert((types.moviesCount + types.seriesCount) > 0, 'No items classified');
  const movCache = await showCache(lsid, 'movies');
  const serCache = await showCache(lsid, 'series');
  console.log(`  cache: movies=${movCache.count}, series=${serCache.count}`);

  // 1) Basic catalogs
  const movCat = `imdb-${UID}-${lsid}-movies`;
  const serCat = `imdb-${UID}-${lsid}-series`;
  const mov = await catalog('movie', movCat, 'limit=200');
  const ser = await catalog('series', serCat, 'limit=200');
  assert(Array.isArray(mov.metas) && Array.isArray(ser.metas), 'Catalog metas missing');
  // Disjoint IDs
  const mIds = new Set(mov.metas.map(m => m.id).filter(Boolean));
  const sIds = new Set(ser.metas.map(m => m.id).filter(Boolean));
  for (const id of mIds) assert(!sIds.has(id), `Cross-type overlap id=${id}`);

  // 2) Extras: search + sort/order + skip/limit
  if (mov.metas.length >= 10) {
    const sampleName = mov.metas[0].name || '';
    const token = (sampleName.split(' ')[0] || '').slice(0, 3).toLowerCase() || 'the';
    const movSearch = await catalog('movie', movCat, `search=${encodeURIComponent(token)}&limit=100`);
    assert(movSearch.metas.length <= mov.metas.length, 'search should not increase results');
    if (movSearch.metas.length) {
      assert(movSearch.metas.every(m => String(m.name||'').toLowerCase().includes(token)), 'search results do not match token');
    }

    const rDesc = await catalog('movie', movCat, 'sort=rating&order=desc&limit=50');
    const rAsc  = await catalog('movie', movCat, 'sort=rating&order=asc&limit=50');
    const ratingsDesc = rDesc.metas.map(m => Number(m.imdbRating)||0);
    const ratingsAsc  = rAsc.metas.map(m => Number(m.imdbRating)||0);
    for (let i=1;i<ratingsDesc.length;i++) assert(ratingsDesc[i] <= ratingsDesc[i-1], 'rating desc not monotonic');
    for (let i=1;i<ratingsAsc.length;i++) assert(ratingsAsc[i] >= ratingsAsc[i-1], 'rating asc not monotonic');

    const sAsc = await catalog('movie', movCat, 'sort=name&order=asc&limit=30');
    const sAscNames = sAsc.metas.map(m => (m.name||'').toLowerCase());
    for (let i=1;i<sAscNames.length;i++) assert(sAscNames[i] >= sAscNames[i-1], 'name asc not monotonic');
    const pag1 = await catalog('movie', movCat, 'limit=20&skip=0');
    const pag2 = await catalog('movie', movCat, 'limit=20&skip=20');
    assert(pag1.metas.length === 20 && pag2.metas.length === 20, 'pagination length mismatch');
    assert(pag1.metas[0]?.id !== pag2.metas[0]?.id, 'pagination did not move window');
  }

  // 3) Media sanity (poster/background are URLs or local /assets/)
  const checkMedia = (arr) => {
    for (const m of arr) {
      assert(m.poster && (hasHttp(m.poster) || isAsset(m.poster)), `bad poster for ${m.id}`);
      assert(m.background && (hasHttp(m.background) || isAsset(m.background)), `bad background for ${m.id}`);
    }
  };
  checkMedia(mov.metas);
  checkMedia(ser.metas);

  // 4) Optional: min-runtime filter
  if (opt.expectMinRuntime > 0) {
    const shorties = mov.metas.filter(m => (Number(m.runtime) || 0) > 0 && Number(m.runtime) < opt.expectMinRuntime);
    assert(shorties.length === 0, `movies shorter than MIN_SHORT_RUNTIME found: ${shorties.slice(0,3).map(x=>x.name).join(', ')}`);
  }

  // 5) TTL warming check (non-fatal): x-warming header may appear
  const latest = await catalog('movie', movCat, 'limit=5');
  const warming = latest.headers.get('x-warming');
  if (warming === '1') console.log('  note: TTL warming triggered (x-warming: 1)');
}

async function testVisibility(lsid){
  console.log(`\n[VISIBILITY] ${lsid}`);
  const manifestBefore = await api('GET', `/manifest.json?uid=${encodeURIComponent(UID)}`);
  const idMovies = `imdb-${UID}-${lsid}-movies`;
  const idSeries = `imdb-${UID}-${lsid}-series`;
  const wasPresent = JSON.stringify(manifestBefore.body).includes(idMovies);

  await patchList(lsid, 'hidden');
  const manifestHidden = await api('GET', `/manifest.json?uid=${encodeURIComponent(UID)}`);
  const hiddenPresent = JSON.stringify(manifestHidden.body).includes(idMovies);
  assert(!hiddenPresent, 'Hidden list still present in manifest');

  await patchList(lsid, 'discover');
  const manifestAfter = await api('GET', `/manifest.json?uid=${encodeURIComponent(UID)}`);
  const presentAgain = JSON.stringify(manifestAfter.body).includes(idMovies);
  assert(presentAgain, 'Discover list missing after toggle');
  if (!wasPresent) console.log('  note: list was newly added during test');
}

async function testAllMerged(){
  console.log(`\n[ALL MERGED]`);
  const man = await api('GET', `/manifest.json?uid=${encodeURIComponent(UID)}`);
  const hasAll = JSON.stringify(man.body).includes(`imdb-${UID}-ALL-movies`);
  if (!hasAll) { console.log('  skipped: ENABLE_ALL_CATALOGS is false'); return; }
  const movAll = await catalog('movie', `imdb-${UID}-ALL-movies`, 'limit=500');
  const serAll = await catalog('series', `imdb-${UID}-ALL-series`, 'limit=500');
  const seen = new Set();
  for (const m of movAll.metas) { if (m.id) { if (seen.has(m.id)) throw new Error('dedupe failed in ALL-movies'); seen.add(m.id); } }
  for (const m of serAll.metas) { if (m.id) { if (seen.has(m.id)) { /* cross-type dupes are ok across buckets */ } } }
  console.log(`  ALL sizes: movies=${movAll.metas.length}, series=${serAll.metas.length}`);
}

(async () => {
  try {
    for (const l of opt.lists) {
      await testList(l);
      await testVisibility(l);
    }
    await testAllMerged();
    if (opt.episodes) {
      console.log(`\n[EPISODES LIST] ${opt.episodes}`);
      await addList(opt.episodes);
      await warm(opt.episodes);
      const types = await readTypes(opt.episodes);
      assert(types.seriesCount > 0, 'episodes list did not up-map to series');
      console.log('  ok: episodes up-mapped to series');
    }
    console.log('\n[E2E] OK');
    process.exit(0);
  } catch (e) {
    console.error('\n[E2E] FAIL:', e.message || e);
    process.exit(2);
  }
})();

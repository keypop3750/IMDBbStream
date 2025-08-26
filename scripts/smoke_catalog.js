// Usage: node scripts/smoke_catalog.js http://localhost:7000 default ls4103816671
import fetch from 'node-fetch';

const [,, BASE='http://localhost:7000', UID='default', LSID=''] = process.argv;
if (!LSID) {
  console.error('Provide LSID, e.g., ls4103816671');
  process.exit(1);
}

function url(p){ return `${BASE}${p}`; }

function uniqueIds(list){ const s = new Set(); for (const m of list) if (m && m.id) s.add(m.id); return s; }

(async () => {
  try {
    // Warm first
    const warm = await fetch(url(`/admin/warm-split?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(LSID)}`)).then(r=>r.json()).catch(()=>({}));
    console.log('[warm]', warm);

    // Fetch catalogs
    const mov = await fetch(url(`/catalog/movie/imdb-${UID}-${LSID}-movies.json?limit=500`)).then(r=>r.json());
    const ser = await fetch(url(`/catalog/series/imdb-${UID}-${LSID}-series.json?limit=500`)).then(r=>r.json());

    const mIds = uniqueIds(mov.metas||[]);
    const sIds = uniqueIds(ser.metas||[]);
    const overlap = [...mIds].filter(x => sIds.has(x));

    console.log(`[movie] ${mIds.size} items`);
    console.log(`[series] ${sIds.size} items`);
    if (overlap.length) {
      console.error(`[ERROR] Cross-type overlap detected: ${overlap.slice(0,10).join(', ')}${overlap.length>10?' …':''}`);
      process.exit(2);
    }
    console.log('[ok] No cross-type overlap; extras working.');
  } catch (e) {
    console.error('[fail]', e);
    process.exit(1);
  }
})();

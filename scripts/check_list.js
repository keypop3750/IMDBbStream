// Usage: node scripts/check_list.js http://localhost:7000 default ls4103816671
import fetch from 'node-fetch';

const [,, BASE='http://localhost:7000', UID='default', LSID=''] = process.argv;
if (!LSID) {
  console.error('Provide LSID, e.g., ls4103816671');
  process.exit(1);
}

function url(p){ return `${BASE}${p}`; }

(async () => {
  try {
    const types = await fetch(url(`/debug/types?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(LSID)}`)).then(r=>r.json());
    console.log('[types]', types);

    const mov = await fetch(url(`/admin/show-cache?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(LSID)}&type=movies`)).then(r=>r.json());
    const ser = await fetch(url(`/admin/show-cache?uid=${encodeURIComponent(UID)}&lsid=${encodeURIComponent(LSID)}&type=series`)).then(r=>r.json());
    console.log(`[movies] count=${mov.count} sample=${(mov.sample||[]).map(x=>x.name).slice(0,5).join(' | ')}`);
    console.log(`[series] count=${ser.count} sample=${(ser.sample||[]).map(x=>x.name).slice(0,5).join(' | ')}`);
    console.log('[ok] caches healthy');
  } catch (e) {
    console.error('[fail]', e);
    process.exit(1);
  }
})();

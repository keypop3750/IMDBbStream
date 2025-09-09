
(() => {
  const qs = new URLSearchParams(location.search);
  const uid = qs.get('uid') || 'default';
  const $ = (q, p=document) => p.querySelector(q);
  const listsEl = $('#lists');
  const addInput = $('#add-input');
  const addBtn = $('#add-btn');
  const installStremio = $('#install-stremio');
  const installWeb = $('#install-web');

  const origin = window.location.origin;
  const hostNoScheme = window.location.host;
  function buildManifestURL() {
    const params = new URLSearchParams({ uid });
    return origin + '/manifest.json?' + params.toString();
  }
  (function wireInstall(){
    const url = buildManifestURL();
    const q = url.split('?')[1] || '';
    installStremio.href = 'stremio://' + hostNoScheme + '/manifest.json?' + q;
    installWeb.href = url;
  })();

  function api(path, init){
    return fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
      .then(async r => { const j = await r.json().catch(()=>({})); if (!r.ok) throw Object.assign(new Error('HTTP '+r.status), { response:j }); return j; });
  }

  async function load(){
    const arr = await api(`/api/user/${encodeURIComponent(uid)}/lists`);
    render(arr || []);
    
    // Trigger preloading for faster addon installation
    if (arr && arr.length > 0) {
      api(`/api/user/${encodeURIComponent(uid)}/preload`, { method: 'POST' })
        .catch(e => console.warn('Preload failed:', e));
    }
  }

  function visFromList(list){
    const legacy = (list.showIn || 'discover').toLowerCase();
    const base = { discover: legacy==='discover'||legacy==='both', home: legacy==='home'||legacy==='both' };
    const mv = (list.visibility && list.visibility.movie)  || base;
    const sv = (list.visibility && list.visibility.series) || base;
    return { movie: { discover: !!mv.discover, home: !!mv.home },
             series:{ discover: !!sv.discover, home: !!sv.home } };
  }

  function Switch(on){ const el=document.createElement('span'); el.className='switch'+(on?' on':''); el.setAttribute('role','switch'); el.setAttribute('aria-checked',on?'true':'false'); return el; }
  function ToggleRow(label, sw){ const wrap=document.createElement('label'); wrap.className='toggle'; wrap.append(label,' ',sw); return wrap; }

  function render(lists){
    listsEl.innerHTML = '';
    if (!lists.length){
      const empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = 'No lists yet. Paste an IMDb list URL above and click Add.';
      listsEl.appendChild(empty);
      return;
    }

    lists.forEach(list => {
      const lsid = list.id || list.lsid || String(list);
      const title = list.title || list.name || lsid;
      const vis = visFromList(list);

      const card = document.createElement('div');
      card.className = 'listCard';

      const head = document.createElement('div');
      head.className = 'listHead';
      head.innerHTML = `<div><div class="listTitle">${escapeHtml(title)}</div><div class="listSub">List ID: ${lsid}</div></div>
                        <button class="btn danger btn-del" title="Remove list">Delete</button>`;
      card.appendChild(head);

      const rows = document.createElement('div');
      rows.className = 'rows2';

      const sRow = document.createElement('div');
      sRow.innerHTML = `<div class="sectionHdr">Series</div>`;
      const sTog = document.createElement('div'); sTog.className = 'toggles';
      const sHome = Switch(vis.series.home);   sHome.dataset.k='series_home';
      const sDisc = Switch(vis.series.discover); sDisc.dataset.k='series_discover';
      sTog.appendChild(ToggleRow('Home', sHome));
      sTog.appendChild(ToggleRow('Discovery', sDisc));
      sRow.appendChild(sTog);

      const mRow = document.createElement('div');
      mRow.innerHTML = `<div class="sectionHdr">Movies</div>`;
      const mTog = document.createElement('div'); mTog.className = 'toggles';
      const mHome = Switch(vis.movie.home);   mHome.dataset.k='movie_home';
      const mDisc = Switch(vis.movie.discover); mDisc.dataset.k='movie_discover';
      mTog.appendChild(ToggleRow('Home', mHome));
      mTog.appendChild(ToggleRow('Discovery', mDisc));
      mRow.appendChild(mTog);

      rows.appendChild(sRow); rows.appendChild(mRow);
      card.appendChild(rows);

      function sendVisibility(){
        const payload = { visibility: {
          movie:  { home: mHome.classList.contains('on'),  discover: mDisc.classList.contains('on') },
          series: { home: sHome.classList.contains('on'),  discover: sDisc.classList.contains('on') }
        }};
        api(`/api/user/${encodeURIComponent(uid)}/lists/${encodeURIComponent(lsid)}`, {
          method: 'PATCH', body: JSON.stringify(payload)
        }).catch(e=>console.warn('PATCH failed', e));
      }

      [sHome,sDisc,mHome,mDisc].forEach(sw => {
        sw.addEventListener('click', () => {
          sw.classList.toggle('on');
          sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
          sendVisibility();
        });
      });

      head.querySelector('.btn-del').addEventListener('click', async () => {
        if (!confirm(`Remove list “${title}”?`)) return;
        try { await api(`/api/user/${encodeURIComponent(uid)}/lists/${encodeURIComponent(lsid)}`, { method: 'DELETE' }); load(); }
        catch(e){ console.warn('DELETE failed', e); }
      });

      listsEl.appendChild(card);
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  addBtn.addEventListener('click', async () => {
    const v = (addInput.value || '').trim();
    if (!v) return;
    addBtn.disabled = true;
    try {
      const res = await api(`/api/user/${encodeURIComponent(uid)}/lists`, { method: 'POST', body: JSON.stringify({ src: v }) });
      if (res && res.id) addInput.value = '';
      await load();
    } catch(e){ alert('Add failed: ' + (e.response && e.response.error ? e.response.error : e.message)); }
    finally { addBtn.disabled = false; }
  });
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

  load();
})();
import fetch from 'node-fetch';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/**
 * Fetch the human-friendly list title from IMDb.
 * Tries HTML first, then CSV export as fallback.
 */
export async function fetchImdbListTitle(listId) {
  // Normalize listId (accept full URL or plain ls… id)
  const m = String(listId).match(/(ls\d{6,})/i);
  const lsid = m ? m[1] : String(listId);
  // Try HTML (fast)
  try {
    const url = `https://www.imdb.com/list/${lsid}/`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (r.ok) {
      const html = await r.text();
      const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1 && h1[1]) return h1[1].trim();
      const t = html.match(/<title>([^<]+?)\s*-\s*IMDb<\/title>/i);
      if (t && t[1]) return t[1].trim();
    }
  } catch {}
  // Fallback: CSV export's first line sometimes contains name
  try {
    const url = `https://www.imdb.com/list/${lsid}/export`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/csv',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (r.ok) {
      const text = await r.text();
      const m2 = text.match(/^\s*title,(.+)$/mi);
      if (m2 && m2[1]) return m2[1].trim();
    }
  } catch {}
  return lsid;
}

/**
 * Scrape up to IMDB_PAGES_MAX pages for tconsts in a list.
 */
export async function fetchImdbIds(listId) {
  const m = String(listId).match(/(ls\d{6,})/i);
  const lsid = m ? m[1] : String(listId);
    const useExport = String(process.env.USE_IMDB_EXPORT_FIRST || 'true').toLowerCase() !== 'false';
  if (useExport) {
    try {
      const url = `https://www.imdb.com/list/${lsid}/export`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/csv',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      if (r.ok) {
        const csv = await r.text();
        // Look for tconst column; fallback: any tt... tokens
        const ids = new Set();
        for (const m of csv.matchAll(/\b(tt\d{7,9})\b/g)) ids.add(m[1]);
        const arr = Array.from(ids);
        if (arr.length > 0) return arr;
      }
    } catch {}
  }
const maxPages = parseInt(process.env.IMDB_PAGES_MAX || '3', 10) || 3;

  const ids = new Set();
  for (let p = 1; p <= maxPages; p++) {
    try {
      const url = `https://www.imdb.com/list/${lsid}/?page=${p}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      if (!r.ok) break;
      const html = await r.text();
      for (const m of html.matchAll(/\/title\/(tt\d{7,9})/g)) ids.add(m[1]);
      for (const m of html.matchAll(/data-tconst=[\"'](tt\d{7,9})[\"']/g)) ids.add(m[1]);
      // stop if there's no "Next" link
      if (!/Next\s*[»>]/i.test(html)) break;
    } catch (e) {
      break;
    }
  }
  return Array.from(ids);
}

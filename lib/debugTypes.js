'use strict';
/**
 * Registers GET /debug/types?uid=default&lsid=ls123456
 * Reads from data/cache/<uid>/<lsid>-ids.json
 *                     and <lsid>-movies.json / <lsid>-series.json
 *                     and <lsid>-types.json (if present)
 */
const fs = require('fs');
const path = require('path');

function safeReadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function registerDebugTypes(app, opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  const cacheDir = path.join(dataDir, 'cache');

  app.get('/debug/types', (req, res) => {
    const uid = (req.query.uid || 'default').toString();
    const lsid = (req.query.lsid || '').toString();
    if (!/^ls\d+$/i.test(lsid)) {
      return res.status(400).json({ error: 'Provide ?lsid=lsXXXXXXXXX' });
    }

    const base = path.join(cacheDir, uid);
    const idsPath = path.join(base, `${lsid}-ids.json`);
    const moviesPath = path.join(base, `${lsid}-movies.json`);
    const seriesPath = path.join(base, `${lsid}-series.json`);
    const typesPath = path.join(base, `${lsid}-types.json`);

    const idsObj = safeReadJSON(idsPath, { ids: [], updatedAt: null });
    const movies = safeReadJSON(moviesPath, []);
    const series = safeReadJSON(seriesPath, []);
    const types = safeReadJSON(typesPath, null);

    const response = {
      uid,
      lsid,
      moviesCount: Array.isArray(movies) ? movies.length : 0,
      seriesCount: Array.isArray(series) ? series.length : 0,
      allIdsCount: Array.isArray(idsObj.ids) ? idsObj.ids.length : 0,
      unknownCount: Math.max(0, (Array.isArray(idsObj.ids) ? idsObj.ids.length : 0) - ((Array.isArray(movies) ? movies.length : 0) + (Array.isArray(series) ? series.length : 0))),
      updatedAt: (types && types.updatedAt) || idsObj.updatedAt || null
    };
    res.json(response);
  });
}

module.exports = { registerDebugTypes };

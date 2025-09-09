
// Lightweight install helper routes for IMDbStream.
// Usage in server.js (once, after `const app = express()`):
//   require('./install-routes')(app);
module.exports = function (app) {
  const express = require('express');
  const url = require('url');

  function normalizeHost(req) {
    // req.hostname is nice but behind proxies it might differ; prefer URL reconstruction
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
    let host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
    // Split and normalize just the hostname (not the port)
    let hostname = host;
    let port = '';
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
    if (m) { hostname = m[1]; port = m[2] || ''; }
    const h = (hostname || '').toLowerCase();
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') hostname = '127.0.0.1';
    const rebuilt = hostname + (port ? ':' + port : '');
    return { proto, host: rebuilt, origin: proto + '://' + rebuilt };
  }

  function getUid(req) {
    const q = req.query || {};
    return String(q.uid || req.cookies?.uid || 'default');
  }

  app.get('/debug/install-url', (req, res) => {
    const { origin } = normalizeHost(req);
    const uid = getUid(req);
    const manifestUrl = origin + '/manifest.json?uid=' + encodeURIComponent(uid);
    const deepLink = 'stremio:///install-addon?addon=' + encodeURIComponent(manifestUrl);
    const webLink = 'https://web.stremio.com/#/addons?addonUrl=' + encodeURIComponent(manifestUrl);
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ uid, manifestUrl, deepLink, webLink });
  });

  app.get('/install', (req, res) => {
    const { origin } = normalizeHost(req);
    const uid = getUid(req);
    res.cookie('uid', uid, { maxAge: 365*24*60*60*1000, sameSite: 'lax' });

    const manifestUrl = origin + '/manifest.json?uid=' + encodeURIComponent(uid);
    const deepHref = 'stremio:///install-addon?addon=' + encodeURIComponent(manifestUrl);

    const html = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${deepHref}">
<p><a href="${deepHref}">Open in Stremio</a></p>
<p>If nothing happens, copy this URL into Stremio: <code>${manifestUrl}</code></p>`;

    res.set('Access-Control-Allow-Origin', '*');
    res.type('html').send(html);
  });
};

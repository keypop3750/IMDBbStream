'use strict';
/**
 * Tiny JSON-line logger for structured events.
 * Usage: logEvent('catalog.request', { uid, lsid, type, skip, limit })
 */
function logEvent(evt, data = {}) {
  try {
    const payload = { ts: new Date().toISOString(), evt, ...data };
    process.stdout.write(JSON.stringify(payload) + '\n');
  } catch (e) {
    // swallow
  }
}

module.exports = { logEvent };

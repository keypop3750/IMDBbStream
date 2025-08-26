#!/usr/bin/env node
// Safe no-op checker for /admin/show-cache route.
// This script intentionally DOES NOT modify server.js.
// It only verifies that the route exists and exits cleanly.

import fs from 'node:fs/promises';
import path from 'node:path';

const SERVER = path.resolve(process.cwd(), 'server.js');

try {
  const src = await fs.readFile(SERVER, 'utf8');
  if (src.includes('/admin/show-cache')) {
    console.log('OK: /admin/show-cache route already present. No changes made.');
    process.exit(0);
  } else {
    console.log('WARNING: /admin/show-cache route not found. This safe script will not modify server.js.');
    process.exit(2);
  }
} catch (e) {
  console.error('ERROR reading server.js:', e?.message || e);
  process.exit(1);
}

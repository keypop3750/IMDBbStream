// Verify syntax of all JS files using Node's parser (node --check).
// Usage: node scripts/verify_syntax.js [rootDir=.]
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(m?js)$/i.test(name)) files.push(p);
  }
}
walk(rootDir);

let failures = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.error(`[syntax] FAIL: ${f}`);
    const out = e.stdout?.toString() || '';
    const err = e.stderr?.toString() || '';
    if (out) console.error(out.trim());
    if (err) console.error(err.trim());
  }
}

if (failures === 0) {
  console.log(`[syntax] OK: ${files.length} files checked`);
  process.exit(0);
} else {
  console.error(`[syntax] ${failures} file(s) failed`);
  process.exit(2);
}

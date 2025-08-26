import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_JSON = path.join(DATA_DIR, 'users.json');

export function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_JSON)) fs.writeFileSync(USERS_JSON, JSON.stringify({}), 'utf8');
}

function readAll() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(USERS_JSON, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function writeAll(db) {
  ensureStorage();
  fs.writeFileSync(USERS_JSON, JSON.stringify(db, null, 2), 'utf8');
}

function normalizeListItem(x) {
  if (typeof x === 'string') {
    return { id: x, showIn: 'discover' };
  }
  if (!x || typeof x !== 'object') {
    return null;
  }
  const id = x.id || x.lsid || (typeof x.toString === 'function' ? String(x).trim() : undefined);
  if (!id) return null;
  const out = { id };
  if (x.title) out.title = x.title;
  if (x.name && !out.title) out.title = x.name;
  out.showIn = x.showIn || 'discover';
  return out;
}

function normalizeUser(user) {
  const u = user && typeof user === 'object' ? { ...user } : { lists: [] };
  const src = Array.isArray(u.lists) ? u.lists : [];
  const norm = [];
  for (const item of src) {
    const n = normalizeListItem(item);
    if (n) norm.push(n);
  }
  u.lists = norm;
  return u;
}

export function getUser(uid) {
  const db = readAll();
  if (!db[uid]) {
    db[uid] = { lists: [] };
    writeAll(db);
    return db[uid];
  }
  // Backfill/normalize lists (string -> {id,...}, default showIn)
  const before = JSON.stringify(db[uid]);
  db[uid] = normalizeUser(db[uid]);
  const after = JSON.stringify(db[uid]);
  if (before !== after) writeAll(db);
  return db[uid];
}

export function upsertUser(uid, user) {
  const db = readAll();
  db[uid] = normalizeUser(user);
  writeAll(db);
}

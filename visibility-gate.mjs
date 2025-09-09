// visibility-gate.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readUserEntry(uid) {
  const unified = [
    path.join(__dirname, "data", "users.json"),
    path.join(process.cwd(), "data", "users.json"),
  ];
  for (const f of unified) {
    try {
      if (fs.existsSync(f)) {
        const obj = JSON.parse(fs.readFileSync(f, "utf8"));
        if (obj && obj[uid]) return obj[uid];
      }
    } catch {}
  }
  const perUser = [
    path.join(__dirname, "store", `${uid}.json`),
    path.join(process.cwd(), "store", `${uid}.json`),
    path.join(__dirname, "data", "users", `${uid}.json`),
    path.join(process.cwd(), "data", "users", `${uid}.json`),
  ];
  for (const f of perUser) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {}
  }
  return null;
}

function getVisibilityFor(uid, lsid, type) {
  const user = readUserEntry(uid);
  if (!user || !Array.isArray(user.lists)) return { discover: true, home: true };
  const hit =
    user.lists.find?.(x => (x?.id || x?.lsid || x) === lsid) ??
    user.lists[lsid];
  const def = { discover: true, home: true };
  if (!hit || !hit.visibility || !hit.visibility[type]) return def;
  const v = hit.visibility[type];
  return {
    discover: typeof v.discover === "boolean" ? v.discover : true,
    home: typeof v.home === "boolean" ? v.home : true
  };
}

function parseCatalogId(catalogId) {
  const m = /^imdb-([^-\s]+)-(ls\d+)-(movies|series)$/i.exec(catalogId || "");
  if (!m) return null;
  const uid = decodeURIComponent(m[1]);
  const lsid = m[2].toLowerCase();
  const type = m[3] === "movies" ? "movie" : "series";
  return { uid, lsid, type };
}

export function mountVisibilityGate(app) {
  const patterns = [
    "/catalog/:type/:catalogId.json",
    "/catalog/:type/:catalogId/genre/:genre.json",
    "/catalog/:type/:catalogId/:extra?.json",
    "/catalog/:type/:catalogId/*",
  ];
  app.use(patterns, (req, res, next) => {
    try {
      const info = parseCatalogId(req.params?.catalogId);
      if (!info) return next();
      const { uid, lsid, type } = info;
      const vis = getVisibilityFor(uid, lsid, type);
      const isDiscover = Boolean(req.query?.genre || req.params?.genre);
      if (vis.discover === false && vis.home === false) {
        res.status(404).json({ err: "CATALOG_DISABLED" }); return;
      }
      if (vis.discover === false && vis.home === true && isDiscover) {
        res.status(404).json({ err: "HIDDEN_FROM_DISCOVER" }); return;
      }
      next();
    } catch {
      next();
    }
  });
}

// Zero-dependency mock API for pManager.
// Run: `node mock-api/server.js`   (needs Node 18+ for global fetch — not used here, so 14+ is fine)
// Endpoints (JSON):
//   GET  /api/sites        -> [ { name, unique, length, classes: {...}, ... }, ... ]
//   PUT  /api/sites        -> body is the full array; replaces the stored list
//   GET  /api/vault-meta   -> { version, argon2, saltB64, ivB64, ctB64 } | null
//   PUT  /api/vault-meta   -> body is the meta object; replaces stored meta
//   OPTIONS /api/*         (CORS preflight)
// Data is persisted to ./data/sites.json and ./data/vault-meta.json.

const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT      = process.env.PORT ? Number(process.env.PORT) : 3001;
const HOST      = process.env.HOST || "127.0.0.1";
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sites.json");
const META_FILE = path.join(DATA_DIR, "vault-meta.json");

const SEED = [
  { name: "GitHub",         category: "Development",    unique: "gh-2024-a1b2",     length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Google",         category: "Work",           unique: "goog-x9y8z7",      length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Microsoft",      category: "Work",           unique: "ms-p0o9i8u7",      length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "LinkedIn",       category: "Work",           unique: "li-c9x8z7a6",      length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Facebook",       category: "Social",         unique: "fb-l1k2j3h4",      length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Twitter / X",    category: "Social",         unique: "x-m5n6b7v8",       length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Amazon",         category: "Shopping",       unique: "amz-q1w2e3r4",     length: 20, classes: { lower: true, upper: true, number: true, symbol: true  } },
  { name: "Netflix",        category: "Entertainment",  unique: "nfx-s5d4f3g2",     length: 16, classes: { lower: true, upper: true, number: true, symbol: false } },
  { name: "Bank (example)", category: "Finance",        unique: "bank-h1j2k3l4-v1", length: 24, classes: { lower: true, upper: true, number: true, symbol: true  } }
];

const CLASS_KEYS = ["lower", "upper", "number", "symbol"];

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(SEED, null, 2), "utf8");
    console.log(`[mock-api] seeded ${DATA_FILE}`);
  }
}

function readSites() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean) : [];
  } catch (err) {
    console.error("[mock-api] read failed:", err.message);
    return [];
  }
}

function writeSitesAtomic(sites) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sites, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function readMeta() {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    const raw = fs.readFileSync(META_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.error("[mock-api] meta read failed:", err.message);
    return null;
  }
}

function writeMetaAtomic(meta) {
  const tmp = META_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
  fs.renameSync(tmp, META_FILE);
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  const unique = String(raw.unique || "").trim();
  if (!name || !unique) return null;
  const category = String(raw.category || "").trim() || "Uncategorized";
  let length = Number(raw.length);
  if (!Number.isFinite(length)) length = 20;
  length = Math.max(4, Math.min(64, Math.round(length)));

  const classes = {};
  const src = (raw.classes && typeof raw.classes === "object") ? raw.classes : {};
  for (const k of CLASS_KEYS) classes[k] = Boolean(src[k]);
  if (!CLASS_KEYS.some((k) => classes[k])) classes.lower = true;

  // note: optional free-form text, capped at 500 chars.
  let note = String(raw.note == null ? "" : raw.note);
  if (note.length > 500) note = note.slice(0, 500);

  // uniqueCreatedAt: ISO-8601 timestamp for the current `unique`. null when unknown (legacy).
  const uniqueCreatedAt = raw.uniqueCreatedAt ? String(raw.uniqueCreatedAt) : null;

  // lastModifiedAt: ISO-8601 timestamp of the most recent field change. null for legacy.
  const lastModifiedAt = raw.lastModifiedAt ? String(raw.lastModifiedAt) : null;

  // history: last 5 previous `unique` values, most-recent first.
  // Each entry: { value, createdAt }. Legacy string entries are upgraded.
  const HIST_MAX = 5;
  const rawHist = Array.isArray(raw.history) ? raw.history : [];
  const seen = new Set([unique]);
  const history = [];
  for (const h of rawHist) {
    let value, createdAt;
    if (typeof h === "string") {
      value = h.trim();
      createdAt = null;
    } else if (h && typeof h === "object") {
      value = String(h.value || "").trim();
      createdAt = h.createdAt ? String(h.createdAt) : null;
    } else {
      continue;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    history.push({ value, createdAt: createdAt || null });
    if (history.length >= HIST_MAX) break;
  }

  return { name, category, unique, length, classes, note, uniqueCreatedAt, lastModifiedAt, history };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
  };
}

function sendJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) { // 1 MB cap
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url === "/api/sites" && method === "GET") {
    return sendJSON(res, 200, readSites());
  }

  if (url === "/api/sites" && method === "PUT") {
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return sendJSON(res, 400, { error: "Body must be a JSON array of sites." });
      }
      const clean = parsed.map(normalize).filter(Boolean);
      writeSitesAtomic(clean);
      return sendJSON(res, 200, clean);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message || "Invalid request" });
    }
  }

  if (url === "/api/vault-meta" && method === "GET") {
    return sendJSON(res, 200, readMeta());
  }

  if (url === "/api/vault-meta" && method === "PUT") {
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" ||
          typeof parsed.saltB64 !== "string" ||
          typeof parsed.ivB64  !== "string" ||
          typeof parsed.ctB64  !== "string") {
        return sendJSON(res, 400, { error: "Malformed vault-meta." });
      }
      writeMetaAtomic(parsed);
      return sendJSON(res, 200, parsed);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message || "Invalid request" });
    }
  }

  if (url === "/api/health" && method === "GET") {
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: "Not found" });
});

ensureDataFile();
server.listen(PORT, HOST, () => {
  console.log(`[mock-api] listening on http://${HOST}:${PORT}`);
  console.log(`[mock-api] data file: ${DATA_FILE}`);
});

// Shared persistence layer for the site list.
// Primary source: the mock API at PM_CONFIG.apiBase.
// Fallback:      last successful response, cached in localStorage under
//                `pmanager.sites.cache.v1`, used only when the API is
//                unreachable (network error, server offline).
// Writes always go to the API. If the API write fails, nothing is persisted
// and the caller is told about the error.

(() => {
  "use strict";

  const CACHE_KEY   = "pmanager.sites.cache.v1";
  const CLASS_KEYS  = ["lower", "upper", "number", "symbol"];

  function config() {
    return window.PM_CONFIG || { apiBase: "", useLocalCache: true };
  }

  function apiUrl(path) {
    const base = (config().apiBase || "").replace(/\/+$/, "");
    return `${base}${path}`;
  }

  function useCache() {
    return config().useLocalCache !== false;
  }

  // Normalize any legacy shape into the current schema.
  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim();
    const unique = String(raw.unique || "").trim();
    if (!name || !unique) return null;

    const category = String(raw.category || "").trim() || "Uncategorized";

    let length = Number(raw.length);
    if (!Number.isFinite(length)) length = 20;
    length = Math.max(4, Math.min(64, Math.round(length)));

    let classes;
    if (raw.classes && typeof raw.classes === "object") {
      classes = {};
      for (const k of CLASS_KEYS) classes[k] = Boolean(raw.classes[k]);
    } else {
      // Legacy: only had a boolean `symbol`. Assume alphanumerics were on.
      classes = {
        lower: true,
        upper: true,
        number: true,
        symbol: Boolean(raw.symbol),
      };
    }
    if (!CLASS_KEYS.some((k) => classes[k])) classes.lower = true;

    // note: optional free-form text. Trimmed and capped at 500 chars.
    let note = String(raw.note == null ? "" : raw.note);
    if (note.length > 500) note = note.slice(0, 500);

    // uniqueCreatedAt: ISO-8601 timestamp of when the current `unique` became active.
    // null for legacy entries where we don't know.
    const uniqueCreatedAt = raw.uniqueCreatedAt ? String(raw.uniqueCreatedAt) : null;

    // lastModifiedAt: ISO-8601 timestamp of the most recent field change.
    // null for legacy entries. Callers are responsible for stamping this on mutation.
    const lastModifiedAt = raw.lastModifiedAt ? String(raw.lastModifiedAt) : null;

    // history: last N previous `unique` values, most-recent first.
    // Each entry: { value: string, createdAt: ISO8601 string }.
    // Deduped by value, non-empty, excludes the current `unique`, capped at 5.
    // Accepts legacy string entries and upgrades them (createdAt = epoch 0 marker).
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

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean) : null;
    } catch (_) {
      return null;
    }
  }

  function writeCache(sites) {
    if (!useCache()) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(sites));
    } catch (_) {
      // Storage quota / disabled — ignore.
    }
  }

  // Returns { sites, source, error? } where source is:
  //   "api"    — fetched fresh from the API
  //   "cache"  — API unreachable, served from localStorage cache
  //   "empty"  — API unreachable and no cache; sites is []
  async function load() {
    try {
      const res = await fetch(apiUrl("/api/sites"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`API responded ${res.status}`);
      const data = await res.json();
      const sites = Array.isArray(data) ? data.map(normalize).filter(Boolean) : [];
      writeCache(sites);
      return { sites, source: "api" };
    } catch (err) {
      const cached = readCache();
      if (cached) return { sites: cached, source: "cache", error: err.message };
      return { sites: [], source: "empty", error: err.message };
    }
  }

  // Sends the full list to the API. Throws on failure.
  async function save(sites) {
    const clean = (sites || []).map(normalize).filter(Boolean);
    const res = await fetch(apiUrl("/api/sites"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clean),
    });
    if (!res.ok) {
      let msg = `API responded ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    const saved = Array.isArray(data) ? data.map(normalize).filter(Boolean) : clean;
    writeCache(saved);
    return saved;
  }

  // Vault metadata (Argon2id salt + encrypted canary). Never cached locally.
  //   loadMeta() -> object | null   (null when the vault has never been set up)
  //   saveMeta(meta) -> stored meta (throws on failure)
  async function loadMeta() {
    const res = await fetch(apiUrl("/api/vault-meta"), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`API responded ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== "object") return null;
    if (typeof data.saltB64 !== "string" ||
        typeof data.ivB64  !== "string" ||
        typeof data.ctB64  !== "string") return null;
    return data;
  }

  async function saveMeta(meta) {
    const res = await fetch(apiUrl("/api/vault-meta"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!res.ok) {
      let msg = `API responded ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return await res.json();
  }

  window.PMStore = {
    CLASS_KEYS,
    normalize,
    load,
    save,
    loadMeta,
    saveMeta,
  };
})();

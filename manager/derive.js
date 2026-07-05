(() => {
  "use strict";

  // Character pools per class.
  const POOLS = {
    lower:  "abcdefghijklmnopqrstuvwxyz",
    upper:  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    number: "0123456789",
    symbol: "!@#$",
  };

  // Argon2id defaults: OWASP 2023 interactive-login profile.
  // Stored per-vault in the meta blob so params can be tuned without
  // invalidating the existing verifier — just re-derive on next unlock.
  const ARGON2_DEFAULT = {
    iterations: 3,
    memorySize: 65536, // KiB → 64 MB
    parallelism: 1,
    hashLength: 32,
  };
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const VERIFIER_PLAINTEXT = "PMANAGER_OK";
  const VERIFIER_INFO = "pmanager/verifier/v1";
  const SITE_INFO_PREFIX = "pmanager/site/v1/";

  function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function argon2Available() {
    return typeof window.hashwasm === "object" &&
      typeof window.hashwasm.argon2id === "function";
  }

  // Derive the raw 32-byte master key from the master password + salt.
  // Expensive (~64 MB, ~0.5–1 s). Called once per unlock.
  async function deriveMasterKey(masterPassword, saltBytes, params) {
    if (!argon2Available()) {
      throw new Error("Argon2id runtime not loaded (hashwasm missing).");
    }
    const p = { ...ARGON2_DEFAULT, ...(params || {}) };
    return await window.hashwasm.argon2id({
      password: masterPassword,
      salt: saltBytes,
      parallelism: p.parallelism,
      iterations: p.iterations,
      memorySize: p.memorySize,
      hashLength: p.hashLength,
      outputType: "binary",
    });
  }

  async function importHkdfKey(rawBytes) {
    return crypto.subtle.importKey(
      "raw", rawBytes, "HKDF", false, ["deriveKey", "deriveBits"]
    );
  }

  // AES-GCM-256 subkey used only to encrypt/decrypt the verifier canary.
  // Domain-separated from per-site keys via HKDF info string.
  async function deriveVerifierKey(masterKey, saltBytes) {
    const base = await importHkdfKey(masterKey);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes,
        info: new TextEncoder().encode(VERIFIER_INFO),
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  // Per-site keystream. HKDF with the site's `unique` in the info string
  // gives every site an independent, deterministic byte stream.
  async function deriveSiteBytes(masterKey, siteUnique, byteLen) {
    const base = await importHkdfKey(masterKey);
    const info = new TextEncoder().encode(SITE_INFO_PREFIX + siteUnique);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
      base,
      byteLen * 8
    );
    return new Uint8Array(bits);
  }

  // First-time setup: generate salt+iv, derive K, encrypt the canary,
  // return both the key (to keep in memory) and the meta blob (to store).
  async function createVerifier(masterPassword, params) {
    const p = { ...ARGON2_DEFAULT, ...(params || {}) };
    const salt = randomBytes(SALT_BYTES);
    const iv   = randomBytes(IV_BYTES);
    const K    = await deriveMasterKey(masterPassword, salt, p);
    const vKey = await deriveVerifierKey(K, salt);
    const pt   = new TextEncoder().encode(VERIFIER_PLAINTEXT);
    const ct   = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vKey, pt)
    );
    return {
      masterKey: K,
      meta: {
        version: 1,
        argon2: p,
        saltB64: b64encode(salt),
        ivB64:   b64encode(iv),
        ctB64:   b64encode(ct),
      },
    };
  }

  // Verify an entered master against a stored verifier blob.
  //   -> { ok: true, masterKey } on success
  //   -> { ok: false }           on AES-GCM auth-tag mismatch (wrong password)
  async function verifyMaster(masterPassword, meta) {
    if (!meta || !meta.saltB64 || !meta.ivB64 || !meta.ctB64) {
      throw new Error("Vault meta is missing or malformed.");
    }
    const salt = b64decode(meta.saltB64);
    const iv   = b64decode(meta.ivB64);
    const ct   = b64decode(meta.ctB64);
    const K    = await deriveMasterKey(
      masterPassword, salt, meta.argon2 || ARGON2_DEFAULT
    );
    const vKey = await deriveVerifierKey(K, salt);
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, vKey, ct);
      if (new TextDecoder().decode(pt) === VERIFIER_PLAINTEXT) {
        return { ok: true, masterKey: K };
      }
      return { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  function buildPool(classes) {
    let pool = "";
    for (const k of ["lower", "upper", "number", "symbol"]) {
      if (classes[k]) pool += POOLS[k];
    }
    return pool;
  }

  function activeClasses(classes) {
    return ["lower", "upper", "number", "symbol"].filter((k) => classes[k]);
  }

  // Returns true if placing b next to a would be repetitive or sequential.
  function isViolation(a, b) {
    if (a === b) return true;
    const diff = Math.abs(a.charCodeAt(0) - b.charCodeAt(0));
    if (diff !== 1) return false;
    const lo = c => c >= "a" && c <= "z";
    const up = c => c >= "A" && c <= "Z";
    const dg = c => c >= "0" && c <= "9";
    return (lo(a) && lo(b)) || (up(a) && up(b)) || (dg(a) && dg(b));
  }

  // Derive a deterministic per-site password from the already-derived
  // master key K. Cheap (< 1 ms) — the expensive Argon2 work happened at unlock.
  async function derivePassword(masterKey, site) {
    const classes = site.classes || {};
    const active = activeClasses(classes);
    if (active.length === 0) {
      throw new Error("At least one character class must be enabled.");
    }

    const requestedLength = site.length != null ? site.length : 20;
    const length = Math.max(active.length, Math.max(8, Math.min(32, requestedLength)));

    const pool = buildPool(classes);
    // Extra bytes buffer to handle sequential/repetitive rejection
    const needed = (length + active.length * 2 + 4) * 8;
    const stream = await deriveSiteBytes(masterKey, site.unique, needed);
    let cursor = 0;

    function pickFrom(fromPool, prev, next) {
      for (let t = 0; t < fromPool.length * 4; t++) {
        const c = fromPool[stream[cursor++ % stream.length] % fromPool.length];
        if ((!prev || !isViolation(c, prev)) && (!next || !isViolation(c, next))) return c;
      }
      for (const c of fromPool) {
        if ((!prev || !isViolation(c, prev)) && (!next || !isViolation(c, next))) return c;
      }
      return fromPool[0];
    }

    const chars = new Array(length);
    for (let i = 0; i < length; i++) {
      chars[i] = pickFrom(pool, i > 0 ? chars[i - 1] : null, null);
    }

    const used = new Set();
    for (const cls of active) {
      const classPool = POOLS[cls];
      let pos = stream[cursor++ % stream.length] % length;
      let tries = 0;
      while (used.has(pos) && used.size < length && tries < length) {
        pos = (pos + 1) % length;
        tries++;
      }
      used.add(pos);
      const prev = pos > 0 ? chars[pos - 1] : null;
      const next = pos < length - 1 ? chars[pos + 1] : null;
      chars[pos] = pickFrom(classPool, prev, next);
    }

    // Verification: if any active class still has no representative, force-place one.
    for (const cls of active) {
      const classPool = POOLS[cls];
      if (chars.some(c => classPool.includes(c))) continue;
      for (let pos = 0; pos < length; pos++) {
        const prev = pos > 0 ? chars[pos - 1] : null;
        const next = pos < length - 1 ? chars[pos + 1] : null;
        chars[pos] = pickFrom(classPool, prev, next);
        break;
      }
    }

    return chars.join("");
  }

  // Derive a deterministic API Bearer token from the master password.
  // Uses PBKDF2-SHA256 with a fixed domain-separation salt — fast (< 100 ms)
  // and independent of the per-vault Argon2 salt stored in vault-meta.
  // The Node.js equivalent (for setup) is in aws/gen-token.js.
  async function deriveApiToken(masterPassword) {
    const fixedSalt = new TextEncoder().encode("pmanager-api-token/v1");
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fixedSalt, iterations: 100000 },
      keyMaterial,
      256
    );
    return Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  window.PMDerive = {
    derivePassword,
    createVerifier,
    verifyMaster,
    deriveApiToken,
    ARGON2_DEFAULT,
  };
})();

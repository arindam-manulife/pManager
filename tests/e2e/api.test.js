"use strict";

/**
 * End-to-end tests for the live deployed pManager API.
 *
 * Runs under jest alongside unit tests.  When API_TOKEN is not set all tests
 * are automatically skipped (shown as pending in the HTML report) so the
 * suite never fails in a CI environment that has no credentials.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   # Unit tests only (default)
 *   cd tests && npm test
 *
 *   # All tests + open HTML dashboard
 *   API_TOKEN=$(node aws/gen-token.js "your-master-password") \
 *   cd tests && npm run test:report:all
 *
 *   # E2E only
 *   API_TOKEN=<token>  cd tests && npm run test:e2e
 *
 * ── Data safety ─────────────────────────────────────────────────────────────
 *
 *   Sites CRUD tests snapshot your current sites in beforeAll and restore
 *   them in afterAll — no permanent changes are made.
 *   Vault-meta tests only round-trip existing data (idempotent PUT) or
 *   test validation errors — the live verifier blob is never replaced.
 */

const assert = require("node:assert/strict");

const API_URL   = (process.env.API_URL || "https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com").replace(/\/$/, "");
const API_TOKEN = process.env.API_TOKEN || "";

// ---- Helpers ----------------------------------------------------------------

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_TOKEN}`,
  };
}

async function apiFetch(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(`${API_URL}${path}`, opts);
}

// ---- Skip all tests gracefully when no token is configured ------------------
// describe.skip marks every test as "pending" in the HTML report instead of
// erroring, so the overall suite still shows green in CI.

const RUN = API_TOKEN ? describe : describe.skip;

// ============================================================================

RUN("pManager E2E Tests", () => {

  // ── Health ────────────────────────────────────────────────────────────────

  describe("Health", () => {
    test("GET /api/health returns 200 { ok: true } — no auth required", async () => {
      const res = await fetch(`${API_URL}/api/health`);
      assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.ok, true);
    });
  });

  // ── Authentication ────────────────────────────────────────────────────────

  describe("Authentication", () => {
    test("GET /api/sites with no Authorization header → 403", async () => {
      const res = await fetch(`${API_URL}/api/sites`);
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    test("GET /api/sites with wrong Bearer token → 403", async () => {
      const res = await fetch(`${API_URL}/api/sites`, {
        headers: { Authorization: `Bearer ${"0".repeat(64)}` },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    test("GET /api/sites with malformed header (no Bearer prefix) → 403", async () => {
      const res = await fetch(`${API_URL}/api/sites`, {
        headers: { Authorization: API_TOKEN },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    test("GET /api/sites with correct Bearer token → 200", async () => {
      const res = await apiFetch("GET", "/api/sites");
      assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    });

    test("OPTIONS preflight succeeds without Authorization header", async () => {
      const res = await fetch(`${API_URL}/api/sites`, {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      });
      assert.ok(res.status < 400, `OPTIONS should not be blocked, got ${res.status}`);
    });
  });

  // ── Sites CRUD ──────────────────────────────────────────────────────────

  describe("Sites CRUD", () => {
    let originalSites = [];

    beforeAll(async () => {
      const res = await apiFetch("GET", "/api/sites");
      assert.equal(res.status, 200);
      originalSites = await res.json();
      console.log(`[e2e] Snapshotted ${originalSites.length} existing site(s) for later restore.`);
    });

    afterAll(async () => {
      const res = await apiFetch("PUT", "/api/sites", originalSites);
      assert.equal(res.status, 200, "Restore of original sites failed!");
      console.log(`[e2e] Restored ${originalSites.length} original site(s).`);
    });

    test("GET /api/sites returns an array", async () => {
      const res = await apiFetch("GET", "/api/sites");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body), `Expected array, got ${typeof body}`);
    });

    test("PUT /api/sites saves and returns normalized sites", async () => {
      const input = [{
        name: "E2E Test Site",
        unique: "e2e-test-unique-abc123",
        category: "Testing",
        length: 20,
        classes: { lower: true, upper: true, number: true, symbol: false },
        note: "Created by automated e2e test",
        username: "e2e-user@example.com",
        siteUrl: "https://e2e-test.example.com",
      }];
      const res = await apiFetch("PUT", "/api/sites", input);
      assert.equal(res.status, 200);
      const saved = await res.json();
      assert.ok(Array.isArray(saved));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].name, "E2E Test Site");
      assert.equal(saved[0].unique, "e2e-test-unique-abc123");
      assert.equal(saved[0].length, 20);
      assert.equal(saved[0].category, "Testing");
      assert.equal(saved[0].username, "e2e-user@example.com");
      assert.equal(saved[0].siteUrl, "https://e2e-test.example.com");
    });

    test("PUT then GET is consistent", async () => {
      const input = [{
        name: "Consistency Check",
        unique: "consistency-xyz-789",
        category: "Test",
        length: 16,
        classes: { lower: true, upper: false, number: true, symbol: false },
        username: "check-user",
        siteUrl: "https://consistency.example.com",
      }];
      await apiFetch("PUT", "/api/sites", input);
      const res = await apiFetch("GET", "/api/sites");
      assert.equal(res.status, 200);
      const fetched = await res.json();
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0].name, "Consistency Check");
      assert.equal(fetched[0].length, 16);
      assert.equal(fetched[0].username, "check-user");
      assert.equal(fetched[0].siteUrl, "https://consistency.example.com");
    });

    test("PUT /api/sites with invalid JSON body → 400", async () => {
      const res = await fetch(`${API_URL}/api/sites`, {
        method: "PUT",
        headers: authHeaders(),
        body: "this is not json {{",
      });
      assert.equal(res.status, 400);
    });

    test("PUT /api/sites with non-array body → 400", async () => {
      const res = await apiFetch("PUT", "/api/sites", { not: "an array" });
      assert.equal(res.status, 400);
    });

    test("PUT filters out sites with missing name", async () => {
      const mixed = [
        { name: "Valid", unique: "v-abc", length: 20, classes: { lower: true } },
        { name: "", unique: "no-name-here" },
      ];
      const res = await apiFetch("PUT", "/api/sites", mixed);
      assert.equal(res.status, 200);
      const saved = await res.json();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].name, "Valid");
    });

    test("PUT clamps length: 1 → 4, 999 → 64", async () => {
      const input = [
        { name: "Short", unique: "sh-u", length: 1,   classes: { lower: true } },
        { name: "Long",  unique: "lg-u", length: 999, classes: { lower: true } },
      ];
      const res = await apiFetch("PUT", "/api/sites", input);
      assert.equal(res.status, 200);
      const [s, l] = await res.json();
      assert.equal(s.length, 4);
      assert.equal(l.length, 64);
    });

    test("PUT defaults to lower=true when all classes are disabled", async () => {
      const input = [{
        name: "NoClass", unique: "nc-u", length: 20,
        classes: { lower: false, upper: false, number: false, symbol: false },
      }];
      const res = await apiFetch("PUT", "/api/sites", input);
      assert.equal(res.status, 200);
      const [site] = await res.json();
      assert.equal(site.classes.lower, true);
    });
  });

  // ── Vault Meta ───────────────────────────────────────────────────────────

  describe("Vault Meta", () => {
    test("GET /api/vault-meta returns null or a valid meta object", async () => {
      const res = await apiFetch("GET", "/api/vault-meta");
      assert.equal(res.status, 200);
      const body = await res.json();
      if (body !== null) {
        assert.equal(typeof body.saltB64, "string", "saltB64 must be a string");
        assert.equal(typeof body.ivB64,   "string", "ivB64 must be a string");
        assert.equal(typeof body.ctB64,   "string", "ctB64 must be a string");
      }
    });

    test("PUT /api/vault-meta round-trips existing data unchanged (idempotent)", async () => {
      const getRes = await apiFetch("GET", "/api/vault-meta");
      const meta = await getRes.json();
      if (!meta) {
        console.log("[e2e] Vault not initialized — skipping idempotent PUT test.");
        return;
      }
      const putRes = await apiFetch("PUT", "/api/vault-meta", meta);
      assert.equal(putRes.status, 200);
      const saved = await putRes.json();
      assert.equal(saved.saltB64, meta.saltB64);
      assert.equal(saved.ivB64,   meta.ivB64);
      assert.equal(saved.ctB64,   meta.ctB64);
    });

    test("PUT /api/vault-meta with missing saltB64 → 400", async () => {
      const res = await apiFetch("PUT", "/api/vault-meta", { ivB64: "x==", ctB64: "y==" });
      assert.equal(res.status, 400);
    });

    test("PUT /api/vault-meta with missing ivB64 → 400", async () => {
      const res = await apiFetch("PUT", "/api/vault-meta", { saltB64: "x==", ctB64: "y==" });
      assert.equal(res.status, 400);
    });

    test("PUT /api/vault-meta with missing ctB64 → 400", async () => {
      const res = await apiFetch("PUT", "/api/vault-meta", { saltB64: "x==", ivB64: "y==" });
      assert.equal(res.status, 400);
    });

    test("PUT /api/vault-meta with empty object → 400", async () => {
      const res = await apiFetch("PUT", "/api/vault-meta", {});
      assert.equal(res.status, 400);
    });

    test("PUT /api/vault-meta with invalid JSON → 400", async () => {
      const res = await fetch(`${API_URL}/api/vault-meta`, {
        method: "PUT",
        headers: authHeaders(),
        body: "not json",
      });
      assert.equal(res.status, 400);
    });
  });

  // ── Unknown routes ───────────────────────────────────────────────────────

  describe("Unknown routes", () => {
    test("GET /api/nonexistent → 404", async () => {
      const res = await apiFetch("GET", "/api/nonexistent");
      assert.equal(res.status, 404);
    });
  });

}); // end RUN

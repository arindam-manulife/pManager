"use strict";

/**
 * Unit tests for the PBKDF2 API token derivation.
 *
 * Tests the same algorithm used in:
 *   - aws/gen-token.js  (Node.js CLI tool)
 *   - vault/derive.js   deriveApiToken()  (browser Web Crypto)
 *   - manager/derive.js deriveApiToken()  (browser Web Crypto)
 *
 * All three must produce identical output for the same input password.
 * The known-vector test anchors this — if the vector fails, something in
 * the derivation parameters has drifted.
 */

const crypto = require("crypto");
const { promisify } = require("util");
const pbkdf2 = promisify(crypto.pbkdf2);

// These parameters must stay in sync with gen-token.js and vault/derive.js.
const SALT       = Buffer.from("pmanager-api-token/v1");
const ITERATIONS = 100_000;
const KEY_LEN    = 32;       // bytes → 64 hex chars
const DIGEST     = "sha256";

async function deriveToken(password) {
  const key = await pbkdf2(password, SALT, ITERATIONS, KEY_LEN, DIGEST);
  return key.toString("hex");
}

// ============================================================================
// Known-vector test
// ============================================================================

describe("API token derivation — known vector", () => {
  test("derives the expected token for the configured master password", async () => {
    // This is the token stored in samconfig.toml.
    // If this test fails it means the derivation parameters have changed —
    // you must regenerate the token and update samconfig.toml before deploying.
    const token = await deriveToken("kakamamababama");
    expect(token).toBe("0561cba06ccb6f0871b1eaebba1d142c7252064a5095b8eb76fa4c4803e1ea1a");
  });
});

// ============================================================================
// Determinism
// ============================================================================

describe("API token derivation — determinism", () => {
  test("same password always produces the same token", async () => {
    const t1 = await deriveToken("my-test-password");
    const t2 = await deriveToken("my-test-password");
    expect(t1).toBe(t2);
  });

  test("is case-sensitive — uppercase produces a different token", async () => {
    const lower = await deriveToken("password");
    const upper = await deriveToken("Password");
    expect(lower).not.toBe(upper);
  });

  test("trailing space produces a different token", async () => {
    const clean = await deriveToken("mypassword");
    const space = await deriveToken("mypassword ");
    expect(clean).not.toBe(space);
  });

  test("different passwords produce different tokens", async () => {
    const t1 = await deriveToken("first-password-abc");
    const t2 = await deriveToken("second-password-xyz");
    expect(t1).not.toBe(t2);
  });
});

// ============================================================================
// Output format
// ============================================================================

describe("API token derivation — output format", () => {
  test("output is exactly 64 lowercase hex characters (32 bytes)", async () => {
    const token = await deriveToken("any-password");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("output contains no uppercase letters", async () => {
    const token = await deriveToken("AnotherPassword123!");
    expect(token).toBe(token.toLowerCase());
  });

  test("output is non-empty for a single-character password", async () => {
    const token = await deriveToken("x");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("output is non-empty for an empty string password", async () => {
    // Edge case: empty password is technically valid input to PBKDF2.
    const token = await deriveToken("");
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// Parameter alignment (guards against accidental drift)
// ============================================================================

describe("API token derivation — parameter alignment", () => {
  test("changing salt produces a different token (domain separation works)", async () => {
    const correct = await pbkdf2("password", Buffer.from("pmanager-api-token/v1"), ITERATIONS, KEY_LEN, DIGEST);
    const wrong   = await pbkdf2("password", Buffer.from("different-salt"), ITERATIONS, KEY_LEN, DIGEST);
    expect(correct.toString("hex")).not.toBe(wrong.toString("hex"));
  });

  test("changing iterations produces a different token", async () => {
    const correct = await pbkdf2("password", SALT, 100_000, KEY_LEN, DIGEST);
    const wrong   = await pbkdf2("password", SALT, 1_000, KEY_LEN, DIGEST);
    expect(correct.toString("hex")).not.toBe(wrong.toString("hex"));
  });
});

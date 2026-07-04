"use strict";

/**
 * Unit tests for aws/lambda/authorizer.js
 *
 * No mocking needed — the authorizer only uses Node's built-in `crypto` module.
 * Each test resets the module so process.env changes take effect cleanly.
 */

const AUTHORIZER_PATH = "../../aws/lambda/authorizer";

// A 64-char hex token (32 bytes) — matches the real token format.
const VALID_TOKEN = "0561cba06ccb6f0871b1eaebba1d142c7252064a5095b8eb76fa4c4803e1ea1a";

function makeEvent(method, authHeader) {
  return {
    requestContext: { http: { method } },
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

describe("authorizer — OPTIONS preflight", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.API_TOKEN = VALID_TOKEN;
  });
  afterEach(() => { delete process.env.API_TOKEN; });

  test("allows OPTIONS regardless of missing token", async () => {
    const auth = require(AUTHORIZER_PATH);
    const result = await auth.handler(makeEvent("OPTIONS", null));
    expect(result.isAuthorized).toBe(true);
  });

  test("allows OPTIONS even with a wrong Bearer token", async () => {
    const auth = require(AUTHORIZER_PATH);
    const result = await auth.handler(makeEvent("OPTIONS", "Bearer wrongtoken"));
    expect(result.isAuthorized).toBe(true);
  });
});

describe("authorizer — valid Bearer token", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.API_TOKEN = VALID_TOKEN;
  });
  afterEach(() => { delete process.env.API_TOKEN; });

  test("authorizes GET with correct token", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", `Bearer ${VALID_TOKEN}`))).isAuthorized).toBe(true);
  });

  test("authorizes PUT with correct token", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("PUT", `Bearer ${VALID_TOKEN}`))).isAuthorized).toBe(true);
  });
});

describe("authorizer — invalid / missing token", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.API_TOKEN = VALID_TOKEN;
  });
  afterEach(() => { delete process.env.API_TOKEN; });

  test("denies request with wrong token (same length)", async () => {
    const auth = require(AUTHORIZER_PATH);
    const wrong = VALID_TOKEN.replace(/.$/, VALID_TOKEN.endsWith("a") ? "b" : "a");
    expect((await auth.handler(makeEvent("GET", `Bearer ${wrong}`))).isAuthorized).toBe(false);
  });

  test("denies request with wrong token (different content)", async () => {
    const auth = require(AUTHORIZER_PATH);
    const wrong = "f".repeat(64);
    expect((await auth.handler(makeEvent("GET", `Bearer ${wrong}`))).isAuthorized).toBe(false);
  });

  test("denies request with no Authorization header", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", null))).isAuthorized).toBe(false);
  });

  test("denies request without Bearer prefix (raw token)", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", VALID_TOKEN))).isAuthorized).toBe(false);
  });

  test("denies request with 'Bearer ' prefix but empty token", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", "Bearer "))).isAuthorized).toBe(false);
  });

  test("denies request with token of shorter length (timing-safe path)", async () => {
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", "Bearer abc123"))).isAuthorized).toBe(false);
  });

  test("denies all non-OPTIONS requests when API_TOKEN env is not set", async () => {
    delete process.env.API_TOKEN;
    const auth = require(AUTHORIZER_PATH);
    expect((await auth.handler(makeEvent("GET", `Bearer ${VALID_TOKEN}`))).isAuthorized).toBe(false);
  });
});

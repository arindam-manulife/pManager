"use strict";

/**
 * Unit tests for aws/lambda/handler.js
 *
 * The AWS SDK is fully mocked — no real AWS calls are made and the SDK
 * does NOT need to be installed locally.  Jest intercepts the require()
 * before Node.js's native resolver runs.
 */

// ---- Mock AWS SDK BEFORE the handler is loaded ----------------------------

jest.mock("@aws-sdk/client-dynamodb", () => {
  // Keep send inside the factory so it is available to the returned mock.
  const send = jest.fn();
  return {
    __send: send,                                   // exposed for test control
    DynamoDBClient: jest.fn(() => ({ send })),
    GetItemCommand: jest.fn((params) => params),
    PutItemCommand:  jest.fn((params) => params),
  };
}, { virtual: true });

jest.mock("@aws-sdk/util-dynamodb", () => ({
  // Identity mocks: tests deal with plain JS objects, not DynamoDB AttributeValues.
  marshall:   jest.fn((obj) => obj),
  unmarshall: jest.fn((obj) => obj),
}), { virtual: true });

// Set required env vars before the handler module is loaded.
process.env.TABLE_NAME     = "test-table";
process.env.ALLOWED_ORIGIN = "*";

// Retrieve the shared mock function AFTER mock registration.
const { __send: mockSend } = require("@aws-sdk/client-dynamodb");
const handler = require("../../aws/lambda/handler");

// ---- Helpers ----------------------------------------------------------------

/** Build a minimal HTTP API v2 event. */
function evt(method, path, body) {
  return {
    requestContext: { http: { method } },
    rawPath: path,
    body:    body !== undefined ? JSON.stringify(body) : "",
    isBase64Encoded: false,
  };
}

/** Build an event with a raw (non-JSON) body string. */
function evtRaw(method, path, rawBody) {
  return { requestContext: { http: { method } }, rawPath: path, body: rawBody, isBase64Encoded: false };
}

beforeEach(() => mockSend.mockReset());

// ============================================================================
// GET /api/health
// ============================================================================

describe("GET /api/health", () => {
  test("returns 200 with { ok: true }", async () => {
    const res = await handler.handler(evt("GET", "/api/health"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

// ============================================================================
// OPTIONS (CORS preflight)
// ============================================================================

describe("OPTIONS preflight", () => {
  test("returns 204 for any OPTIONS path", async () => {
    const res = await handler.handler(evt("OPTIONS", "/api/sites"));
    expect(res.statusCode).toBe(204);
  });
});

// ============================================================================
// GET /api/sites
// ============================================================================

describe("GET /api/sites", () => {
  test("returns [] when DynamoDB has no record", async () => {
    mockSend.mockResolvedValueOnce({ Item: null });
    const res = await handler.handler(evt("GET", "/api/sites"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  test("returns stored sites when record exists", async () => {
    const sites = [
      { name: "GitHub", unique: "gh-abc", category: "Dev", length: 20,
        classes: { lower: true, upper: true, number: true, symbol: true },
        note: "", history: [] },
    ];
    mockSend.mockResolvedValueOnce({ Item: { PK: "sites", data: sites } });
    const res = await handler.handler(evt("GET", "/api/sites"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(sites);
  });
});

// ============================================================================
// PUT /api/sites
// ============================================================================

describe("PUT /api/sites", () => {
  test("normalizes and saves a valid sites array", async () => {
    mockSend.mockResolvedValueOnce({});
    const input = [
      { name: "GitHub", unique: "gh-abc", category: "Dev", length: 20,
        classes: { lower: true, upper: true, number: true, symbol: true } },
    ];
    const res = await handler.handler(evt("PUT", "/api/sites", input));
    expect(res.statusCode).toBe(200);
    const saved = JSON.parse(res.body);
    expect(Array.isArray(saved)).toBe(true);
    expect(saved[0].name).toBe("GitHub");
    expect(saved[0].unique).toBe("gh-abc");
    expect(saved[0].category).toBe("Dev");
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await handler.handler(evtRaw("PUT", "/api/sites", "not json {{"));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/JSON/i);
  });

  test("returns 400 when body is an object, not an array", async () => {
    const res = await handler.handler(evt("PUT", "/api/sites", { name: "oops" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/array/i);
  });

  test("filters out entries missing name", async () => {
    mockSend.mockResolvedValueOnce({});
    const input = [
      { name: "Valid",  unique: "v-abc", length: 20, classes: { lower: true } },
      { name: "",       unique: "no-name" },
    ];
    const res = await handler.handler(evt("PUT", "/api/sites", input));
    const saved = JSON.parse(res.body);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Valid");
  });

  test("filters out entries missing unique", async () => {
    mockSend.mockResolvedValueOnce({});
    const input = [
      { name: "Valid", unique: "v-abc", length: 20, classes: { lower: true } },
      { name: "No Unique", unique: "" },
    ];
    const res = await handler.handler(evt("PUT", "/api/sites", input));
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  test("saves an empty array (clears all sites)", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites", []));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  test("clamps length below 4 up to 4", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "S", unique: "s-u", length: 1, classes: { lower: true } }]
    ));
    expect(JSON.parse(res.body)[0].length).toBe(4);
  });

  test("clamps length above 64 down to 64", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "L", unique: "l-u", length: 999, classes: { lower: true } }]
    ));
    expect(JSON.parse(res.body)[0].length).toBe(64);
  });

  test("defaults length to 20 when not a finite number", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "D", unique: "d-u", length: "abc", classes: { lower: true } }]
    ));
    expect(JSON.parse(res.body)[0].length).toBe(20);
  });

  test("defaults category to 'Uncategorized' when blank", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "X", unique: "x-u", category: "  ", length: 20, classes: { lower: true } }]
    ));
    expect(JSON.parse(res.body)[0].category).toBe("Uncategorized");
  });

  test("falls back to lower=true when all character classes are disabled", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "X", unique: "x-u", length: 20,
         classes: { lower: false, upper: false, number: false, symbol: false } }]
    ));
    expect(JSON.parse(res.body)[0].classes.lower).toBe(true);
  });

  test("truncates note to 500 characters", async () => {
    mockSend.mockResolvedValueOnce({});
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "N", unique: "n-u", length: 20, classes: { lower: true }, note: "x".repeat(600) }]
    ));
    expect(JSON.parse(res.body)[0].note.length).toBe(500);
  });

  test("keeps note under 500 characters unchanged", async () => {
    mockSend.mockResolvedValueOnce({});
    const shortNote = "short note";
    const res = await handler.handler(evt("PUT", "/api/sites",
      [{ name: "N", unique: "n-u", length: 20, classes: { lower: true }, note: shortNote }]
    ));
    expect(JSON.parse(res.body)[0].note).toBe(shortNote);
  });

  test("deduplicates history entries and limits to 5", async () => {
    mockSend.mockResolvedValueOnce({});
    const input = [{
      name: "H", unique: "h-current", length: 20, classes: { lower: true },
      history: [
        { value: "h-old-1", createdAt: null },
        { value: "h-old-2", createdAt: null },
        { value: "h-old-3", createdAt: null },
        { value: "h-old-4", createdAt: null },
        { value: "h-old-5", createdAt: null },
        { value: "h-old-6", createdAt: null }, // 6th → trimmed
        { value: "h-current", createdAt: null }, // duplicate of unique → removed
      ],
    }];
    const res = await handler.handler(evt("PUT", "/api/sites", input));
    const saved = JSON.parse(res.body)[0];
    expect(saved.history.length).toBeLessThanOrEqual(5);
    expect(saved.history.every(h => h.value !== "h-current")).toBe(true);
  });
});

// ============================================================================
// GET /api/vault-meta
// ============================================================================

describe("GET /api/vault-meta", () => {
  test("returns null when no record in DynamoDB", async () => {
    mockSend.mockResolvedValueOnce({ Item: null });
    const res = await handler.handler(evt("GET", "/api/vault-meta"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  test("returns vault-meta when all required fields are present", async () => {
    const meta = { saltB64: "abc==", ivB64: "def==", ctB64: "ghi==",
                   argon2: { iterations: 3, memorySize: 65536, parallelism: 1, hashLength: 32 },
                   version: 1 };
    mockSend.mockResolvedValueOnce({ Item: { PK: "vault-meta", data: meta } });
    const res = await handler.handler(evt("GET", "/api/vault-meta"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.saltB64).toBe("abc==");
    expect(body.ivB64).toBe("def==");
    expect(body.ctB64).toBe("ghi==");
  });

  test("returns null when stored record is missing saltB64", async () => {
    mockSend.mockResolvedValueOnce({ Item: { PK: "vault-meta", data: { ivB64: "x", ctB64: "y" } } });
    const res = await handler.handler(evt("GET", "/api/vault-meta"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });
});

// ============================================================================
// PUT /api/vault-meta
// ============================================================================

describe("PUT /api/vault-meta", () => {
  test("saves valid meta and returns it", async () => {
    mockSend.mockResolvedValueOnce({});
    const meta = { saltB64: "abc==", ivB64: "def==", ctB64: "ghi==",
                   argon2: { iterations: 3, memorySize: 65536, parallelism: 1, hashLength: 32 },
                   version: 1 };
    const res = await handler.handler(evt("PUT", "/api/vault-meta", meta));
    expect(res.statusCode).toBe(200);
    const saved = JSON.parse(res.body);
    expect(saved.saltB64).toBe("abc==");
    expect(saved.ivB64).toBe("def==");
    expect(saved.ctB64).toBe("ghi==");
  });

  test("returns 400 for invalid JSON body", async () => {
    const res = await handler.handler(evtRaw("PUT", "/api/vault-meta", "bad json"));
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when saltB64 is missing", async () => {
    const res = await handler.handler(evt("PUT", "/api/vault-meta", { ivB64: "x", ctB64: "y" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/vault-meta/i);
  });

  test("returns 400 when ivB64 is missing", async () => {
    const res = await handler.handler(evt("PUT", "/api/vault-meta", { saltB64: "x", ctB64: "y" }));
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when ctB64 is missing", async () => {
    const res = await handler.handler(evt("PUT", "/api/vault-meta", { saltB64: "x", ivB64: "y" }));
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 for empty object", async () => {
    const res = await handler.handler(evt("PUT", "/api/vault-meta", {}));
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// Unknown routes
// ============================================================================

describe("unknown routes", () => {
  test("returns 404 for an unrecognised path", async () => {
    const res = await handler.handler(evt("GET", "/api/unknown-endpoint"));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not found/i);
  });

  test("returns 404 for a valid path with wrong method", async () => {
    const res = await handler.handler(evt("DELETE", "/api/sites"));
    expect(res.statusCode).toBe(404);
  });
});

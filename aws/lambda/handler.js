// pManager API — AWS Lambda handler
// Mirrors the mock-api/server.js behaviour exactly.
//
// Routes:
//   GET  /api/sites        → array of sites
//   PUT  /api/sites        → replace full array, returns saved array
//   GET  /api/vault-meta   → vault meta object | null
//   PUT  /api/vault-meta   → replace vault meta, returns saved object
//   GET  /api/health       → { ok: true }

"use strict";

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const db     = new DynamoDBClient({});
const TABLE  = process.env.TABLE_NAME;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// ---- CORS -----------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":          ORIGIN,
    "Access-Control-Allow-Methods":         "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers":         "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age":               "600",
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

// ---- Normalisation (mirrors mock-api/server.js) ---------------------------

const CLASS_KEYS = ["lower", "upper", "number", "symbol"];

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name   = String(raw.name   || "").trim();
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

  let note = String(raw.note == null ? "" : raw.note);
  if (note.length > 500) note = note.slice(0, 500);

  const uniqueCreatedAt = raw.uniqueCreatedAt ? String(raw.uniqueCreatedAt) : null;
  const lastModifiedAt  = raw.lastModifiedAt  ? String(raw.lastModifiedAt)  : null;

  const HIST_MAX = 5;
  const rawHist  = Array.isArray(raw.history) ? raw.history : [];
  const seen     = new Set([unique]);
  const history  = [];
  for (const h of rawHist) {
    let value, createdAt;
    if (typeof h === "string") {
      value = h.trim(); createdAt = null;
    } else if (h && typeof h === "object") {
      value     = String(h.value     || "").trim();
      createdAt = h.createdAt ? String(h.createdAt) : null;
    } else continue;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    history.push({ value, createdAt: createdAt || null });
    if (history.length >= HIST_MAX) break;
  }

  return { name, category, unique, length, classes, note, uniqueCreatedAt, lastModifiedAt, history };
}

// ---- DynamoDB helpers -----------------------------------------------------

async function dbGet(pk) {
  const res = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ PK: pk }),
  }));
  return res.Item ? unmarshall(res.Item) : null;
}

async function dbPut(pk, data) {
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({ PK: pk, data }, { removeUndefinedValues: true }),
  }));
}

// ---- Route handlers -------------------------------------------------------

async function handleGetSites() {
  const item = await dbGet("sites");
  const sites = item && Array.isArray(item.data) ? item.data : [];
  return respond(200, sites);
}

async function handlePutSites(rawBody) {
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch {
    return respond(400, { error: "Invalid JSON." });
  }
  if (!Array.isArray(parsed)) {
    return respond(400, { error: "Body must be a JSON array of sites." });
  }
  const clean = parsed.map(normalize).filter(Boolean);
  await dbPut("sites", clean);
  return respond(200, clean);
}

async function handleGetVaultMeta() {
  const item = await dbGet("vault-meta");
  if (!item || !item.data) return respond(200, null);
  const d = item.data;
  if (typeof d.saltB64 !== "string" ||
      typeof d.ivB64  !== "string" ||
      typeof d.ctB64  !== "string") return respond(200, null);
  return respond(200, d);
}

async function handlePutVaultMeta(rawBody) {
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch {
    return respond(400, { error: "Invalid JSON." });
  }
  if (!parsed || typeof parsed !== "object" ||
      typeof parsed.saltB64 !== "string" ||
      typeof parsed.ivB64  !== "string" ||
      typeof parsed.ctB64  !== "string") {
    return respond(400, { error: "Malformed vault-meta." });
  }
  await dbPut("vault-meta", parsed);
  return respond(200, parsed);
}

// ---- Main handler ---------------------------------------------------------

exports.handler = async (event) => {
  // Support both API Gateway HTTP API (v2) and REST API (v1) event shapes.
  const method = (event.requestContext?.http?.method || event.httpMethod || "GET").toUpperCase();
  const path   = event.rawPath || event.path || "/";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  const body = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body)
    : "";

  try {
    if (path === "/api/health"     && method === "GET") return respond(200, { ok: true });
    if (path === "/api/sites"      && method === "GET") return await handleGetSites();
    if (path === "/api/sites"      && method === "PUT") return await handlePutSites(body);
    if (path === "/api/vault-meta" && method === "GET") return await handleGetVaultMeta();
    if (path === "/api/vault-meta" && method === "PUT") return await handlePutVaultMeta(body);

    return respond(404, { error: "Not found." });
  } catch (err) {
    console.error("[pmanager] unhandled error:", err);
    return respond(500, { error: "Internal server error." });
  }
};

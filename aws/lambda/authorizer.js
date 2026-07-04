// pManager Bearer Token Authorizer
// HTTP API v2 Lambda authorizer (simple response format).
// Derives API token from master password via PBKDF2 (see aws/gen-token.js).
// Constant-time comparison prevents timing attacks.

"use strict";

const crypto = require("crypto");

exports.handler = async (event) => {
  // CORS preflight — always allow so the browser can negotiate headers.
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { isAuthorized: true };
  }

  const expected = process.env.API_TOKEN || "";
  if (!expected) {
    console.log("[auth] API_TOKEN env var not set — denying all requests");
    return { isAuthorized: false };
  }

  const authHeader = event.headers?.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Constant-time comparison to prevent timing-based token oracle attacks.
  let ok = false;
  if (token.length > 0 && token.length === expected.length) {
    ok = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  console.log(`[auth] allowed=${ok}`);
  return { isAuthorized: ok };
};

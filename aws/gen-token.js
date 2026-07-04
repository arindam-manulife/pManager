#!/usr/bin/env node
// gen-token.js — derive the API Bearer token from your master password.
// Run once, then paste the output into samconfig.toml as ApiToken="<hex>".
//
// Usage:
//   node aws/gen-token.js "your master password"

"use strict";

const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node aws/gen-token.js \"your master password\"");
  process.exit(1);
}

// Must match the PBKDF2 parameters in vault/derive.js deriveApiToken().
const salt       = Buffer.from("pmanager-api-token/v1");
const iterations = 100_000;
const keyLen     = 32;
const digest     = "sha256";

crypto.pbkdf2(password, salt, iterations, keyLen, digest, (err, key) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(key.toString("hex"));
});

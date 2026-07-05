# pManager — Testing Guide

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Test Structure](#2-test-structure)
3. [Unit Tests](#3-unit-tests)
4. [E2E Tests (Live API)](#4-e2e-tests-live-api)
5. [HTML Test Dashboard](#5-html-test-dashboard)
6. [Run Everything at Once](#6-run-everything-at-once)
7. [Understanding Test Output](#7-understanding-test-output)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

| Tool | Minimum Version | Install (macOS) |
|---|---|---|
| Node.js | 18+ | `brew install node` |
| npm | 8+ | included with Node.js |

No AWS credentials are required for unit tests. E2E tests require the deployed API to be running and your master password.

---

## 2. Test Structure

```
tests/
├── package.json              # jest config, dependencies, npm scripts
├── run.sh                    # convenience shell runner
├── reports/                  # generated HTML reports (git-ignored)
│   └── test-report.html
├── unit/
│   ├── authorizer.test.js    # Lambda authorizer — token validation logic
│   ├── handler.test.js       # Lambda handler — all API routes and normalization
│   └── gen-token.test.js     # PBKDF2 token derivation and known-vector check
└── e2e/
    └── api.test.js           # Live API end-to-end tests (skipped if no API_TOKEN)
```

| Test file | Tests | Runner | AWS calls | Needs deploy |
|---|---|---|---|---|
| `unit/authorizer.test.js` | 11 | jest | None | No |
| `unit/handler.test.js` | 33 | jest | None (mocked) | No |
| `unit/gen-token.test.js` | 11 | jest | None | No |
| `e2e/api.test.js` | 27 | jest | Real HTTPS | Yes |

All four files run under **jest**. An HTML dashboard is written to `tests/reports/test-report.html` after every run.

---

## 3. Unit Tests

Unit tests use **jest** and make no real AWS calls. The AWS SDK is fully mocked. Run them from the repo root or from inside `tests/`.

### Step 1 — Install dependencies (first time only)

```bash
cd tests
npm install
```

This installs jest (~30 MB). You only need to run this once.

### Step 2 — Run all unit tests

```bash
cd tests
npm test
```

Expected output:

```
PASS unit/authorizer.test.js
  authorizer — OPTIONS preflight
    ✓ allows OPTIONS regardless of missing token
    ✓ allows OPTIONS even with a wrong Bearer token
  authorizer — valid Bearer token
    ✓ authorizes GET with correct token
    ✓ authorizes PUT with correct token
  authorizer — invalid / missing token
    ✓ denies request with wrong token (same length)
    ✓ denies request with wrong token (different content)
    ✓ denies request with no Authorization header
    ✓ denies request without Bearer prefix (raw token)
    ✓ denies request with 'Bearer ' prefix but empty token
    ✓ denies request with token of shorter length (timing-safe path)
    ✓ denies all non-OPTIONS requests when API_TOKEN env is not set

PASS unit/handler.test.js
  ...29 tests...

PASS unit/gen-token.test.js
  ...11 tests...

Tests: 55 passed, 55 total

📦 report is created on: tests/reports/test-report.html
```

An HTML report is written automatically after every run — open it with:

```bash
open tests/reports/test-report.html   # macOS
```

Or use the combined script to run and open in one step:

```bash
npm run test:report
```

### Run a single test file

```bash
cd tests
npx jest unit/authorizer.test.js
npx jest unit/handler.test.js
npx jest unit/gen-token.test.js
```

### Run tests matching a name pattern

```bash
cd tests
npx jest --testNamePattern="vault"          # all tests with "vault" in the name
npx jest --testNamePattern="PUT /api/sites" # specific route tests
```

### Run in watch mode (re-runs on file changes)

```bash
cd tests
npx jest --watch
```

---

## 4. E2E Tests (Live API)

E2E tests run under **jest** alongside unit tests and hit the real deployed API over HTTPS. When `API_TOKEN` is not set the entire suite is automatically marked as **pending** (skipped) — the overall run still shows green and the HTML dashboard indicates the tests were skipped rather than failed.

> **Data safety:** The Sites CRUD tests snapshot your current sites in `beforeAll` and restore them in `afterAll` — no permanent data changes are made. Vault-meta tests only round-trip the existing blob (idempotent PUT) or test validation errors — the live verifier is never replaced.

### Step 1 — Install dependencies (if not done already)

```bash
cd tests
npm install
```

### Step 2 — Derive your API token

```bash
# Run from the repo root
node aws/gen-token.js "your-master-password"
```

This prints a 64-character hex token. Copy it.

### Step 3 — Run E2E tests only

```bash
cd tests
API_TOKEN=<paste-token-here> npm run test:e2e
```

Or derive and run in one command (from the repo root):

```bash
API_TOKEN=$(node aws/gen-token.js "your-master-password") bash tests/run.sh e2e
```

### Step 4 — Optional: use a different API URL

By default the tests use the current deployed URL. To override:

```bash
cd tests
API_URL=https://your-api-id.execute-api.ca-central-1.amazonaws.com \
API_TOKEN=$(node aws/gen-token.js "your-master-password") \
npm run test:e2e
```

### Expected output (jest format)

```
PASS e2e/api.test.js
  pManager E2E Tests
    Health
      ✓ GET /api/health returns 200 { ok: true } — no auth required (312 ms)
    Authentication
      ✓ GET /api/sites with no Authorization header → 403 (98 ms)
      ✓ GET /api/sites with wrong Bearer token → 403 (87 ms)
      ✓ GET /api/sites with correct Bearer token → 200 (94 ms)
      ✓ OPTIONS preflight succeeds without Authorization header (88 ms)
    Sites CRUD
      [e2e] Snapshotted 9 existing site(s) for later restore.
      ✓ GET /api/sites returns an array (102 ms)
      ✓ PUT /api/sites saves and returns normalized sites (110 ms)
      ...
      [e2e] Restored 9 original site(s).
    Vault Meta
      ✓ GET /api/vault-meta returns null or a valid meta object (95 ms)
      ...
    Unknown routes
      ✓ GET /api/nonexistent → 404 (89 ms)

Tests: 25 passed, 51 total
📦 report is created on: tests/reports/test-report.html
```

### When API_TOKEN is not set

```
PASS e2e/api.test.js
  pManager E2E Tests [skipped — set API_TOKEN env var to run]
    ○ skipped

Tests: 55 passed, 27 skipped, 82 total
```

Skipped tests appear as **pending** (grey) in the HTML dashboard — the suite still passes.

---

## 5. HTML Test Dashboard

Every jest run (unit or E2E) automatically writes an HTML report to:

```
tests/reports/test-report.html
```

### Open the report

```bash
open tests/reports/test-report.html          # macOS — open manually
```

### Generate report and open automatically

```bash
# Unit tests only — generate + open
cd tests && npm run test:report

# All tests (unit + E2E) — generate + open
API_TOKEN=$(node aws/gen-token.js "your-master-password") \
cd tests && npm run test:report:all
```

### What the dashboard shows

| Section | Description |
|---|---|
| Summary bar | Total passed / failed / pending counts and overall duration |
| Suite breakdown | Pass/fail per test file with individual timings |
| Expandable tree | Click any suite to see all describe blocks and test names |
| Pending tests | E2E tests shown as grey/pending when `API_TOKEN` not set |

> The `tests/reports/` folder is listed in `.gitignore` — generated reports are never committed.

---

## 6. Run Everything at Once

### Quick-reference: all npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm test` | `cd tests && npm test` | Unit tests only |
| `npm run test:unit` | `cd tests && npm run test:unit` | Unit tests only (explicit) |
| `npm run test:e2e` | `API_TOKEN=<t> npm run test:e2e` | E2E tests only |
| `npm run test:all` | `API_TOKEN=<t> npm run test:all` | Unit + E2E tests |
| `npm run test:report` | `cd tests && npm run test:report` | Unit tests + open HTML report |
| `npm run test:report:all` | `API_TOKEN=<t> npm run test:report:all` | Unit + E2E + open HTML report |

### Using run.sh (from the repo root)

The `run.sh` script installs dependencies, runs tests, and handles the `API_TOKEN` check.

```bash
# Unit tests only
bash tests/run.sh unit

# E2E tests only
API_TOKEN=$(node aws/gen-token.js "your-master-password") bash tests/run.sh e2e

# All tests (unit + E2E)
API_TOKEN=$(node aws/gen-token.js "your-master-password") bash tests/run.sh
```

---

## 7. Understanding Test Output

### What each unit test suite validates

#### `authorizer.test.js`
Validates the Lambda Bearer token authorizer in isolation:
- OPTIONS preflight is always allowed (no token needed)
- Correct token → authorized
- Wrong token, missing header, wrong format → denied
- Empty `API_TOKEN` env var → denies everything

#### `handler.test.js`
Validates every API route with a mocked DynamoDB (no real AWS calls):
- All routes return correct status codes
- Input normalization: length clamped to 4–64, category defaults, note truncation, history deduplication
- Validation errors return 400 with a descriptive message
- Unknown routes return 404

#### `gen-token.test.js`
Validates the PBKDF2 token derivation:

> **Critical test:** `derives the expected token for the configured master password`
> This test verifies that `node aws/gen-token.js "kakamamababama"` still produces `0561cba0...`.
> If this test fails it means the derivation parameters have drifted — you must regenerate the token and update `aws/samconfig.toml`.

### What the E2E tests validate

- Authentication is enforced on all non-OPTIONS endpoints
- All 4 API routes are reachable and return correct HTTP status codes
- Input validation works end-to-end (400 errors propagate correctly)
- Sites CRUD: PUT → GET is consistent; data is normalized correctly
- Data safety: original sites are restored after every run

---

## 8. Troubleshooting

### `npm install` fails or jest not found

Make sure you are inside the `tests/` directory when running `npm install`:

```bash
cd /path/to/pManager/tests
npm install
npm test
```

### E2E tests show as skipped / pending in the report

This is expected when `API_TOKEN` is not set. The suite uses `describe.skip` so tests appear as pending (grey) rather than failing. To run them:

```bash
API_TOKEN=$(node aws/gen-token.js "your-master-password") bash tests/run.sh e2e
```

### E2E: all requests return 403

The token does not match what is deployed. Check:

1. Regenerate the token: `node aws/gen-token.js "your-master-password"`
2. Compare with the value in `aws/samconfig.toml` under `ApiToken=`
3. If they differ, update `samconfig.toml` and redeploy: `bash aws/deploy-frontend.sh`

### HTML report not opening automatically

`npm run test:report` uses `open` which is macOS-only. On Linux use:

```bash
cd tests && npm test && xdg-open reports/test-report.html
```

### E2E: `fetch is not a function`

Your Node.js version is below 18. Upgrade:

```bash
brew install node   # installs latest LTS
node --version      # should be 18+
```

### Unit test: `known vector` test fails

The `gen-token.test.js` known-vector test is failing, which means the derivation parameters in `aws/gen-token.js` or `vault/derive.js` have been changed. You must:

1. Regenerate the token: `node aws/gen-token.js "your-master-password"`
2. Update `aws/samconfig.toml` with the new token
3. Redeploy: `bash aws/deploy-frontend.sh`
4. Update the expected value in `tests/unit/gen-token.test.js`

### Unit test: handler tests fail after changing handler.js

Run `npm test` again after any change to `aws/lambda/handler.js`. If a new route or normalization rule was added, update the corresponding test in `tests/unit/handler.test.js`.

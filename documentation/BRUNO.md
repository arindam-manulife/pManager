# pManager — Bruno API Collection Guide

[Bruno](https://www.usebruno.com/) is a fast, offline API client. The pManager collection lives in `mock-api/bruno/` and covers all API endpoints for both local development and the live AWS environment.

---

## Collection Structure

```
mock-api/bruno/
├── bruno.json                   # Collection metadata
├── environments/
│   ├── Local.bru                # Local mock server (no auth required)
│   └── Production.bru           # Live AWS API (Bearer token required)
├── Health/
│   └── Health Check.bru         # GET /api/health — no auth
├── Sites/
│   ├── Get Sites.bru            # GET /api/sites
│   └── Replace Sites.bru        # PUT /api/sites
└── Vault Meta/
    ├── Get Vault Meta.bru       # GET /api/vault-meta
    └── Replace Vault Meta.bru   # PUT /api/vault-meta
```

---

## Prerequisites

- **Bruno** desktop app — download from https://www.usebruno.com/downloads

---

## Opening the Collection

1. Launch Bruno.
2. Click **Open Collection**.
3. Navigate to `mock-api/bruno/` inside the repo and select that folder.
4. The **pManager API** collection will appear in the sidebar.

---

## Environments

| Environment | Base URL | Auth |
|---|---|---|
| **Local** | `http://127.0.0.1:3001` | None (mock server has no auth) |
| **Production** | `https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com` | Bearer token required |

Switch environments using the dropdown in the top-right corner of Bruno.

---

## Setting Up the Production Token

The live API is protected by a PBKDF2-derived Bearer token. You must generate it from your master password before using the Production environment.

### Step 1 — Generate the token

Run from the repo root:

```bash
node aws/gen-token.js "your-master-password"
```

Example output:

```
Master password : your-master-password
API token (hex) : 0561cba06ccb6f0871b1eaebba1d142c7252064a5095b8eb76fa4c4803e1ea1a
```

### Step 2 — Set it in Bruno

1. In Bruno, open **Environments** → **Production**.
2. Find the `apiToken` variable row.
3. Paste the hex token into the **Value** column.
4. Save.

> **Security:** `apiToken` is marked as a secret variable (`vars:secret`) — Bruno will mask it in the UI and will not sync it to version control.

All authenticated requests (`Get Sites`, `Replace Sites`, `Get Vault Meta`, `Replace Vault Meta`) automatically send `Authorization: Bearer {{apiToken}}` using this value.

---

## Using the Local Environment

1. Start the mock server from the repo root:

```bash
node mock-api/server.js
```

The server starts on `http://127.0.0.1:3001` and reads/writes JSON files in `mock-api/data/`.

2. Select the **Local** environment in Bruno.
3. Run any request — no token is needed, the mock server has no authentication.

---

## Endpoints

### Health Check
| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/health` |
| **Auth** | None |
| **Response** | `{ "ok": true }` |

No authentication required. Use this to verify the API is reachable.

---

### Get Sites
| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/sites` |
| **Auth** | Bearer token |
| **Response** | Array of site config objects |

Returns the full list of saved sites. Returns `[]` if no sites have been saved yet.

---

### Replace Sites
| | |
|---|---|
| **Method** | `PUT` |
| **Path** | `/api/sites` |
| **Auth** | Bearer token |
| **Body** | JSON array of site config objects |
| **Response** | The normalized array that was saved |

Replaces the entire sites list. Send `[]` to clear all sites.

**Site config object fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Yes | Display name |
| `unique` | string | Yes | Per-site KDF salt |
| `category` | string | No | Defaults to `"Uncategorized"` |
| `length` | integer | No | 8–32 — defaults to 20 |
| `classes` | object | No | `{ lower, upper, number, symbol }` — defaults `lower: true` if all false |
| `username` | string | No | Account username or email |
| `siteUrl` | string | No | URL to open the site |
| `note` | string | No | Max 500 characters |
| `uniqueCreatedAt` | ISO-8601 string | No | When the current unique was set |
| `lastModifiedAt` | ISO-8601 string | No | Last field change |
| `history` | array | No | Up to 5 previous unique values |

---

### Get Vault Meta
| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/vault-meta` |
| **Auth** | Bearer token |
| **Response** | Vault meta object or `null` |

Returns the encrypted verifier blob used to validate the master password on unlock. Returns `null` if the vault has never been initialised.

---

### Replace Vault Meta
| | |
|---|---|
| **Method** | `PUT` |
| **Path** | `/api/vault-meta` |
| **Auth** | Bearer token |
| **Body** | JSON vault meta object |
| **Response** | The saved meta object |

> **Warning:** Replacing vault meta with an incorrect blob will lock you out. Only call this endpoint if you know what you are doing — the app manages this automatically on first unlock.

**Vault meta fields:**

| Field | Type | Required |
|---|---|---|
| `saltB64` | base64 string | Yes |
| `ivB64` | base64 string | Yes |
| `ctB64` | base64 string | Yes |
| `argon2` | object | No |
| `version` | integer | No |

---

## Authentication Reference

| Endpoint | Local | Production |
|---|---|---|
| `GET /api/health` | No auth | No auth |
| `GET /api/sites` | No auth (mock) | Bearer token |
| `PUT /api/sites` | No auth (mock) | Bearer token |
| `GET /api/vault-meta` | No auth (mock) | Bearer token |
| `PUT /api/vault-meta` | No auth (mock) | Bearer token |

The Bearer token is derived from the master password using PBKDF2-SHA256 (100,000 iterations, fixed salt `pmanager-api-token/v1`). See `aws/gen-token.js` for the reference implementation.

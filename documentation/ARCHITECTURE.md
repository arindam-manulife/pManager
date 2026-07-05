# pManager — Full System Architecture

## Overview

pManager is a **stateless, zero-knowledge password manager** deployed entirely on AWS serverless infrastructure. Passwords are never stored anywhere — they are **deterministically derived** on the client from a master password + a unique site string using Argon2id + HKDF. The backend stores only site configuration metadata and an encrypted verifier blob.

---

## High-Level System Diagram

```mermaid
graph TB
    subgraph CLIENT["Client (Browser)"]
        direction TB
        subgraph VAULT["Vault App — d28qqey4ujtj4r.cloudfront.net"]
            V_HTML["index.html"]
            V_APP["app.js<br/>(session, unlock, generate)"]
            V_DERIVE["derive.js<br/>(Argon2id · HKDF · PBKDF2)"]
            V_STORE["storage.js<br/>(API client + localStorage cache)"]
            V_THEME["theme.js<br/>(light/dark)"]
            V_ARGON["argon2.umd.min.js<br/>(hashwasm — WASM)"]
            V_CFG["config.js<br/>(apiBase URL)"]
        end
        subgraph MANAGER["Manager App — d2xizde5tcfavk.cloudfront.net"]
            M_HTML["index.html"]
            M_APP["manage.js<br/>(CRUD, categories, history)"]
            M_DERIVE["derive.js<br/>(Argon2id · HKDF · PBKDF2)"]
            M_STORE["storage.js<br/>(API client + localStorage cache)"]
            M_THEME["theme.js<br/>(light/dark)"]
            M_ARGON["argon2.umd.min.js<br/>(hashwasm — WASM)"]
            M_CFG["config.js<br/>(apiBase URL)"]
        end
    end

    subgraph AWS["AWS — ca-central-1"]
        subgraph CDN["CloudFront CDN"]
            CF_VAULT["Vault Distribution<br/>E3SQ153SFVDDIK"]
            CF_MGR["Manager Distribution<br/>E3LG7FGZ7FL6RX"]
        end
        subgraph S3["S3 Static Hosting"]
            S3_VAULT["pmanager-vault-…<br/>(OAC — private)"]
            S3_MGR["pmanager-manager-…<br/>(OAC — private)"]
        end
        subgraph API["API Gateway — HTTP API v2"]
            APIGW["5paq7xm6v5.execute-api<br/>.ca-central-1.amazonaws.com"]
            AUTH["Lambda Authorizer<br/>pmanager-authorizer-pmanager<br/>Bearer token · PBKDF2"]
        end
        subgraph COMPUTE["Lambda — Node.js 24 · arm64"]
            HANDLER["pmanager-api-pmanager<br/>handler.js<br/>GET/PUT sites · GET/PUT vault-meta"]
        end
        subgraph DB["DynamoDB"]
            DDB["pmanager-pmanager<br/>PK=sites → [ ] array<br/>PK=vault-meta → { } object<br/>SSE · PITR enabled"]
        end
    end

    %% CDN → S3
    CF_VAULT -->|"OAC sigv4"| S3_VAULT
    CF_MGR   -->|"OAC sigv4"| S3_MGR

    %% Client → CDN
    VAULT -->|"HTTPS"| CF_VAULT
    MANAGER -->|"HTTPS"| CF_MGR

    %% Client → API
    V_STORE -->|"HTTPS + Bearer token"| APIGW
    M_STORE -->|"HTTPS + Bearer token"| APIGW

    %% API Gateway flow
    APIGW -->|"every non-OPTIONS request"| AUTH
    AUTH  -->|"isAuthorized=true"| HANDLER
    HANDLER -->|"GetItem / PutItem"| DDB
```

---

## Authentication Flow

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant PBKDF2 as "Web Crypto PBKDF2"
    participant Argon2 as "Argon2id (WASM)"
    participant API as "API Gateway + Authorizer"
    participant DDB as "DynamoDB"

    User->>Browser: Enter master password
    Browser->>PBKDF2: deriveApiToken(password)<br/>salt="pmanager-api-token/v1"<br/>100k iterations · SHA-256
    PBKDF2-->>Browser: 32-byte hex token (fast ~50ms)

    Browser->>API: GET /api/vault-meta<br/>Authorization: Bearer {token}
    API->>API: timingSafeEqual(token, API_TOKEN)
    alt Wrong password → wrong token
        API-->>Browser: 403 Forbidden
        Browser-->>User: "Wrong master password."
    else Token matches
        API->>DDB: GetItem PK="vault-meta"
        DDB-->>API: { saltB64, ivB64, ctB64, argon2 }
        API-->>Browser: vault-meta JSON

        Browser->>Argon2: argon2id(password, salt)<br/>64 MB · 3 iter · 1 thread
        Argon2-->>Browser: 32-byte master key K (~800ms)

        Browser->>Browser: AES-GCM-256 decrypt verifier<br/>using HKDF(K, "pmanager/verifier/v1")
        alt Decryption fails (auth tag mismatch)
            Browser-->>User: "Wrong master password."
        else Verifier = "PMANAGER_OK"
            Browser-->>User: Session unlocked ✓
        end
    end
```

---

## Password Derivation (Zero-Knowledge)

```mermaid
flowchart LR
    PWD["Master Password"]
    SALT["Vault Salt\n(random, stored in DynamoDB)"]
    ARGON["Argon2id\n64 MB · 3 iter"]
    K["Master Key K\n32 bytes — memory only"]
    UNIQUE["Site Unique String\n(stored in DynamoDB)"]
    HKDF["HKDF-SHA256\ninfo = 'pmanager/site/v1/' + unique"]
    STREAM["Byte Stream\n(deterministic)"]
    POOL["Character Pool\n(lower/upper/number/symbol)"]
    PASS["Site Password\n(never stored anywhere)"]

    PWD & SALT --> ARGON --> K
    K & UNIQUE --> HKDF --> STREAM
    STREAM & POOL --> PASS
```

**Key property:** The same `(master password, unique string)` pair always produces the same site password. Nothing is stored — the password vanishes when the session locks.

**Password composition rules (enforced at generation time):**

| Rule | Detail |
|---|---|
| **Length** | 8–32 characters (set per-site in the Manager) |
| **Character classes** | Lowercase · Uppercase · Numbers · Symbols — each toggled per site |
| **Symbol pool** | `!@#$` |
| **Minimum class coverage** | Every enabled class contributes ≥ 1 character to the final password |
| **No repetitive characters** | A character cannot appear consecutively (e.g. `aa`, `11`) |
| **No sequential characters** | Adjacent characters in the same class cannot differ by 1 code point (e.g. `ab`, `78`, `YZ`) |

---

## Data Model

```mermaid
erDiagram
    DYNAMODB_TABLE {
        string partitionKey "Partition key"
        json   data         "Payload"
    }

    SITES_RECORD {
        string partitionKey "= 'sites'"
        array  data         "Array of SiteConfig objects"
    }

    VAULT_META_RECORD {
        string partitionKey "= 'vault-meta'"
        string saltB64  "Argon2 salt (base64, 16 bytes)"
        string ivB64    "AES-GCM IV (base64, 12 bytes)"
        string ctB64    "Encrypted verifier ciphertext"
        object argon2   "{ iterations, memorySize, parallelism, hashLength }"
        int    version  "Schema version (= 1)"
    }

    SITE_CONFIG {
        string name
        string category
        string unique          "Unique string — the KDF salt per site"
        int    length          "Password length (8–32)"
        object classes         "{ lower, upper, number, symbol }"
        string note            "Optional free-form note (max 500 chars)"
        string username        "Optional account username / email"
        string siteUrl         "Optional URL to open the site directly"
        string uniqueCreatedAt "ISO-8601 — when current unique was set"
        string lastModifiedAt  "ISO-8601 — last field change"
        array  history         "Last 5 previous unique values"
    }

    DYNAMODB_TABLE ||--|| SITES_RECORD : "PK=sites"
    DYNAMODB_TABLE ||--|| VAULT_META_RECORD : "PK=vault-meta"
    SITES_RECORD   ||--o{ SITE_CONFIG : "data[]"
```

---

## Infrastructure (AWS SAM / CloudFormation)

```mermaid
graph LR
    subgraph CFN["CloudFormation Stack: pmanager · ca-central-1"]
        direction TB

        P1["Parameter: AllowedOrigin\n(CORS origin)"]
        P2["Parameter: ApiToken\n(PBKDF2-derived Bearer token)\nNoEcho=true"]

        DDB2["DynamoDB Table\nDeletionPolicy: Retain\nSSE: AWS-managed\nPITR: 35-day recovery"]

        AUTH2["Lambda: Authorizer\nNodejs 24 · arm64 · 256 MB\nEnv: API_TOKEN"]
        PERM["Lambda Permission\nPrincipal: apigateway.amazonaws.com"]
        FN["Lambda: Handler\nNodejs 24 · arm64 · 256 MB · 15s\nEnv: TABLE_NAME\nPolicy: DynamoDBCrudPolicy"]

        APIGW2["HTTP API v2\nDefaultAuthorizer: Bearer\nCORS: GET PUT OPTIONS\nAllowHeaders: Content-Type Authorization"]

        S3V["S3: Vault bucket\npmanager-vault-{acct}-{stack}"]
        S3M["S3: Manager bucket\npmanager-manager-{acct}-{stack}"]
        OAC["CloudFront OAC\nsigv4 signing"]
        CFV["CloudFront: Vault\nOrigin: S3V + OAC"]
        CFM["CloudFront: Manager\nOrigin: S3M + OAC"]

        P2 --> AUTH2
        AUTH2 --> PERM --> APIGW2
        FN --> APIGW2
        FN -->|"DynamoDB CRUD"| DDB2
        OAC --> CFV & CFM
        S3V --> CFV
        S3M --> CFM
    end
```

---

## Frontend Module Dependency

```mermaid
graph TD
    subgraph vault["Vault App"]
        VI["index.html"] --> VT["theme.js"]
        VI --> VA2["argon2.umd.min.js"]
        VI --> VC["config.js"]
        VI --> VD["derive.js"]
        VI --> VS["storage.js"]
        VI --> VAP["app.js"]
        VAP -->|"window.PMDerive"| VD
        VAP -->|"window.PMStore"| VS
        VS  -->|"window.PM_CONFIG"| VC
    end

    subgraph manager["Manager App"]
        MI["index.html"] --> MT["theme.js"]
        MI --> MA2["argon2.umd.min.js"]
        MI --> MC["config.js"]
        MI --> MD["derive.js"]
        MI --> MS["storage.js"]
        MI --> MAp["manage.js"]
        MAp -->|"window.PMDerive"| MD
        MAp -->|"window.PMStore"| MS
        MS  -->|"window.PM_CONFIG"| MC
    end
```

---

## Local Development

```mermaid
graph LR
    DEV["Developer Browser\nlocalhost"]
    MOCK["mock-api/server.js\nNode.js · port 3001\nno auth · JSON files"]
    FILES["mock-api/data/\nsites.json\nvault-meta.json"]

    DEV -->|"HTTP (no HTTPS)"| MOCK
    MOCK <-->|"read/write"| FILES
```

Set `apiBase: "http://127.0.0.1:3001"` in `config.js` to use the mock server locally.

---

## Security Properties

| Property | Mechanism |
|---|---|
| **Passwords never stored** | Derived at runtime via Argon2id + HKDF; wiped on lock |
| **API protected** | PBKDF2 Bearer token derived from master password |
| **Token comparison** | `crypto.timingSafeEqual` — immune to timing attacks |
| **CORS preflight** | OPTIONS passthrough; all data methods require Bearer token |
| **Vault data encrypted** | AES-GCM-256 verifier; site configs stored in plaintext (not sensitive) |
| **S3 not public** | CloudFront OAC + sigv4 — S3 buckets have no public access |
| **DynamoDB at rest** | SSE enabled (AWS-managed key) |
| **DynamoDB recovery** | Point-in-time recovery — 35-day window |
| **Session timeout** | 5-minute inactivity lock; master key wiped from memory |
| **No master password stored** | Wiped from DOM immediately after Argon2 derivation |

---

## Deployment Pipeline

```mermaid
flowchart LR
    SRC["Source Code\n(local)"]
    BUILD["sam build\n.aws-sam/build/"]
    DEPLOY["sam deploy\nCloudFormation changeset"]
    S3SYNC["aws s3 sync\n--cache-control no-cache"]
    CF_INV["CloudFront invalidation\n/*"]

    SRC --> BUILD --> DEPLOY --> S3SYNC --> CF_INV

    DEPLOY -->|"updates"| LAMBDA["Lambda functions\n+ Authorizer"]
    DEPLOY -->|"updates"| APIGW3["API Gateway\nCORS / Auth config"]
    S3SYNC -->|"vault/"| S3_V["S3 Vault bucket"]
    S3SYNC -->|"manager/"| S3_M["S3 Manager bucket"]
```

**Script:** `bash aws/deploy-frontend.sh` — runs all steps end-to-end.

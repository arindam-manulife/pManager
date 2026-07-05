# pManager — Step-by-Step Deployment Guide

This document covers every step to deploy pManager from scratch, run subsequent updates, and manage the live stack.

---

## Table of Contents

1. [Current Stack Info](#1-current-stack-info)
2. [Prerequisites](#2-prerequisites)
3. [First-Time Setup](#3-first-time-setup)
4. [Generate API Token](#4-generate-api-token)
5. [Build the SAM Application](#5-build-the-sam-application)
6. [Deploy the AWS Stack (First Time)](#6-deploy-the-aws-stack-first-time)
7. [Upload Frontend Files to S3](#7-upload-frontend-files-to-s3)
8. [Verify the Deployment](#8-verify-the-deployment)
9. [Subsequent Deployments](#9-subsequent-deployments)
10. [One-Command Deploy Script](#10-one-command-deploy-script)
11. [Invalidate CloudFront Cache](#11-invalidate-cloudfront-cache)
12. [Update the API Token](#12-update-the-api-token)
13. [Useful AWS Commands](#13-useful-aws-commands)
14. [Troubleshooting](#14-troubleshooting)
15. [Changing the Master Password](#15-changing-the-master-password)
16. [Tear-Down](#16-tear-down)

---

## 1. Current Stack Info

| Resource | Value |
|---|---|
| Stack name | `pmanager` |
| AWS Region | `ca-central-1` |
| AWS Account ID | `864138843762` |
| API Gateway URL | `https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com` |
| Lambda — API Handler | `pmanager-api-pmanager` |
| Lambda — Authorizer | `pmanager-authorizer-pmanager` |
| DynamoDB Table | `pmanager-pmanager` |
| Manager S3 Bucket | `pmanager-manager-864138843762-pmanager` |
| Vault S3 Bucket | `pmanager-vault-864138843762-pmanager` |
| **Manager App URL** | **https://d2xizde5tcfavk.cloudfront.net** |
| **Vault App URL** | **https://d28qqey4ujtj4r.cloudfront.net** |
| CloudFront — Manager | `E3LG7FGZ7FL6RX` |
| CloudFront — Vault | `E3SQ153SFVDDIK` |

---

## 2. Prerequisites

### Required tools

| Tool | Minimum Version | Install (macOS) |
|---|---|---|
| AWS CLI v2 | 2.x | `brew install awscli` |
| AWS SAM CLI | 1.x | `brew install aws-sam-cli` |
| Node.js | 20+ | `brew install node` |

Verify all three are installed:

```bash
aws --version
sam --version
node --version
```

### macOS SSL fix (one-time, if needed)

If AWS CLI commands fail with `SSL: CERTIFICATE_VERIFY_FAILED`:

```bash
security find-certificate -a -p /Library/Keychains/System.keychain > /tmp/aws-ca-bundle.pem
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> /tmp/aws-ca-bundle.pem
echo "ca_bundle = /tmp/aws-ca-bundle.pem" >> ~/.aws/config
```

> **Note:** `/tmp/` is cleared on reboot. Re-run the first two `security` lines after every restart.

---

## 3. First-Time Setup

### Configure AWS credentials

```bash
aws configure
```

Enter when prompted:

| Prompt | Value |
|---|---|
| AWS Access Key ID | your IAM access key |
| AWS Secret Access Key | your IAM secret key |
| Default region name | `ca-central-1` |
| Default output format | `json` |

Verify credentials are working:

```bash
aws sts get-caller-identity
```

Expected output (account/ARN will vary):

```json
{
    "UserId": "AIDAXXXXXXXXXXXXXXXXX",
    "Account": "864138843762",
    "Arn": "arn:aws:iam::864138843762:user/your-username"
}
```

---

## 4. Generate API Token

The API is protected by a Bearer token that is **derived from your master password** using PBKDF2-SHA256. You must generate this token and store it in `aws/samconfig.toml` before deploying.

```bash
# Run from the repo root
node aws/gen-token.js "your-master-password"
```

Example output:

```
Master password : your-master-password
API token (hex) : 0561cba06ccb6f0871b1eaebba1d142c7252064a5095b8eb76fa4c4803e1ea1a
```

Copy the hex token. Open `aws/samconfig.toml` and set it in `parameter_overrides`:

```toml
parameter_overrides = "AllowedOrigin=\"*\" AllowedIPs=\"unused\" ApiToken=\"<paste-token-here>\""
```

> **Important:** The token must match the master password you will use to unlock the app. If you change your master password, regenerate the token and redeploy.

---

## 5. Build the SAM Application

Run from the **repo root**:

```bash
sam build --template-file aws/template.yaml
```

This compiles the Lambda source files in `aws/lambda/` into the `.aws-sam/build/` directory.

> The warning `package.json file not found` is safe to ignore — the Lambda has no npm dependencies.

---

## 6. Deploy the AWS Stack (First Time)

### Option A — Guided interactive deploy (recommended for first deploy)

```bash
sam deploy --guided \
  --template-file aws/template.yaml \
  --config-file aws/samconfig.toml
```

SAM will prompt for each parameter. Accept the defaults (they are already set in `samconfig.toml`) and answer `y` to save the config file.

### Option B — Non-interactive deploy (subsequent runs)

```bash
sam deploy \
  --template-file aws/template.yaml \
  --config-file aws/samconfig.toml \
  --no-confirm-changeset
```

### What gets created

| CloudFormation Resource | AWS Service |
|---|---|
| `PManagerTable` | DynamoDB table (`DeletionPolicy: Retain`) |
| `PManagerFunction` | Lambda — API handler (Node.js 24, arm64) |
| `PManagerAuthorizerFunction` | Lambda — Bearer token authorizer |
| `PManagerApi` | API Gateway HTTP API v2 |
| `PManagerManagerBucket` | S3 bucket — Manager frontend |
| `PManagerVaultBucket` | S3 bucket — Vault frontend |
| `PManagerOAC` | CloudFront Origin Access Control |
| `PManagerManagerDistribution` | CloudFront distribution — Manager |
| `PManagerVaultDistribution` | CloudFront distribution — Vault |
| `PManagerFunctionRole` | IAM role (DynamoDB CRUD only) |

> **First deploy only:** CloudFront distributions take **~10 minutes** to fully propagate. The URLs will work immediately but global edge caching takes time.

At the end of the deploy, SAM prints the stack outputs:

```
-------------------------------------------------
Outputs
-------------------------------------------------
Key    ManagerUrl
Value  https://d2xizde5tcfavk.cloudfront.net

Key    VaultUrl
Value  https://d28qqey4ujtj4r.cloudfront.net
...
-------------------------------------------------
```

---

## 7. Upload Frontend Files to S3

After the stack is deployed, upload the static frontend files.

### Manager app

```bash
aws s3 sync manager/ s3://pmanager-manager-864138843762-pmanager \
  --delete \
  --exclude ".DS_Store" \
  --cache-control "no-cache, no-store, must-revalidate"
```

### Vault app

```bash
aws s3 sync vault/ s3://pmanager-vault-864138843762-pmanager \
  --delete \
  --exclude ".DS_Store" \
  --cache-control "no-cache, no-store, must-revalidate"
```

> The `--cache-control "no-cache, no-store, must-revalidate"` flag ensures browsers always fetch the latest files and do not cache stale JS/CSS.

---

## 8. Verify the Deployment

### Check the stack is healthy

```bash
aws cloudformation describe-stacks \
  --stack-name pmanager \
  --query "Stacks[0].StackStatus"
```

Expected: `"UPDATE_COMPLETE"` or `"CREATE_COMPLETE"`.

### Test the API directly

```bash
# Should return 200 with { "status": "ok" }
curl -s https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com/api/health
```

### Open the apps

- **Vault:** https://d28qqey4ujtj4r.cloudfront.net
- **Manager:** https://d2xizde5tcfavk.cloudfront.net

---

## 9. Subsequent Deployments

When you change Lambda code or the SAM template:

```bash
# 1. Rebuild
sam build --template-file aws/template.yaml

# 2. Deploy stack changes
sam deploy \
  --template-file aws/template.yaml \
  --config-file aws/samconfig.toml \
  --no-confirm-changeset

# 3. Re-sync frontend (if any frontend files changed)
aws s3 sync manager/ s3://pmanager-manager-864138843762-pmanager \
  --delete --exclude ".DS_Store" --cache-control "no-cache, no-store, must-revalidate"

aws s3 sync vault/ s3://pmanager-vault-864138843762-pmanager \
  --delete --exclude ".DS_Store" --cache-control "no-cache, no-store, must-revalidate"
```

---

## 10. One-Command Deploy Script

The `aws/deploy-frontend.sh` script performs **all steps** in one shot:

```bash
bash aws/deploy-frontend.sh
```

It does:
1. `sam build`
2. `sam deploy --no-confirm-changeset`
3. Reads S3 bucket names from CloudFormation stack outputs
4. `aws s3 sync` for both Manager and Vault with no-cache headers
5. **CloudFront cache invalidation** for both distributions (`/*`)
6. Prints the live URLs

Run from the **repo root** at any time to redeploy everything.

---

## 11. Invalidate CloudFront Cache

CloudFront caches files at edge locations. If you deployed new frontend files but users are still seeing the old version, create an invalidation:

### Manager distribution

```bash
aws cloudfront create-invalidation \
  --distribution-id E3LG7FGZ7FL6RX \
  --paths "/*"
```

### Vault distribution

```bash
aws cloudfront create-invalidation \
  --distribution-id E3SQ153SFVDDIK \
  --paths "/*"
```

### Invalidate both at once

```bash
for DIST in E3LG7FGZ7FL6RX E3SQ153SFVDDIK; do
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*"
done
```

> Invalidations typically complete within **1–2 minutes**.

---

## 12. Update the API Token

If you change your master password, you must regenerate the token and redeploy:

```bash
# 1. Generate new token
node aws/gen-token.js "your-new-master-password"

# 2. Update aws/samconfig.toml with the new token in parameter_overrides

# 3. Redeploy the stack (updates the Lambda environment variable)
sam build --template-file aws/template.yaml
sam deploy --template-file aws/template.yaml \
           --config-file aws/samconfig.toml \
           --no-confirm-changeset
```

---

## 13. Useful AWS Commands

| Command | Purpose |
|---|---|
| `aws cloudformation describe-stacks --stack-name pmanager` | View full stack status and all outputs |
| `aws cloudformation describe-stacks --stack-name pmanager --query "Stacks[0].StackStatus"` | Quick status check |
| `sam logs -n pmanager-api-pmanager --tail` | Stream live Lambda logs |
| `sam logs -n pmanager-authorizer-pmanager --tail` | Stream authorizer logs |
| `aws dynamodb scan --table-name pmanager-pmanager` | Inspect DynamoDB data |
| `aws s3 ls s3://pmanager-manager-864138843762-pmanager` | List Manager S3 files |
| `aws s3 ls s3://pmanager-vault-864138843762-pmanager` | List Vault S3 files |
| `aws cloudfront list-invalidations --distribution-id E3SQ153SFVDDIK` | Check invalidation status |

---

## 14. Troubleshooting

### `sam build` — command not found
SAM CLI is not installed. Run `brew install aws-sam-cli`.

### `Unable to locate credentials`
AWS CLI is not configured. Run `aws configure` and enter your IAM access key and secret.

### `SSL: CERTIFICATE_VERIFY_FAILED`
macOS system certificates not trusted by the AWS CLI. See [macOS SSL fix](#macos-ssl-fix-one-time-if-needed) above.

### `No changes to deploy`
The stack is already up to date. SAM exits with a non-zero code when there are no changes — this is safe to ignore. The deploy script uses `|| true` to handle this.

### `403 Forbidden` on API calls
- Wrong master password → wrong derived token → authorizer rejects it.
- Check `aws/samconfig.toml` has the correct `ApiToken` value (regenerate with `node aws/gen-token.js`).
- Check the Lambda `API_TOKEN` env var matches: `aws lambda get-function-configuration --function-name pmanager-authorizer-pmanager --query Environment`.

### `Failed to fetch` / CORS error in browser
- The app HTML is being opened as a `file://` URL. Always use the CloudFront URL.
- Or run a local dev server: `python3 -m http.server 8080` then open `http://localhost:8080/vault/`.

### Sites show empty after login
- Caused by stale JS cached in CloudFront. Run a CloudFront invalidation (see [Step 11](#11-invalidate-cloudfront-cache)).

### CloudFront serving old files after S3 update
Run a CloudFront invalidation for both distributions (see [Step 11](#11-invalidate-cloudfront-cache)).

---

## 15. Changing the Master Password

### Will my site passwords change?

**Yes — all derived site passwords will change.**

Every site password is derived from the chain:

```
Argon2id(master password, vault salt) → Master Key K
HKDF(K, site unique string)           → Site Password
```

Changing the master password produces a different `K`. A different `K` means **every single site password is different**. This is by design — the master password is the root of the entire key hierarchy.

> **Plan ahead.** Before changing, generate and record your current passwords for all sites — you will need to update them on every website after the change.

---

### Step-by-Step: Changing the Master Password

#### Step 1 — Record all current site passwords

Open the Vault app, unlock with your **current** master password, and note down every generated password. You will need these to log in to each website and update to the new password.

#### Step 2 — Delete the vault-meta record from DynamoDB

The vault is re-initialized automatically when the `vault-meta` record is absent. Delete it:

```bash
aws dynamodb delete-item \
  --table-name pmanager-pmanager \
  --key '{"PK":{"S":"vault-meta"}}'
```

> **Note:** This does **not** delete your sites list — only the verifier blob used to validate the master password.

#### Step 3 — Generate a new API token from the new password

```bash
node aws/gen-token.js "your-new-master-password"
```

Copy the output hex token.

#### Step 4 — Update samconfig.toml

Open `aws/samconfig.toml` and replace the `ApiToken` value:

```toml
parameter_overrides = "AllowedOrigin=\"*\" AllowedIPs=\"unused\" ApiToken=\"<new-hex-token>\""
```

#### Step 5 — Redeploy the stack

```bash
bash aws/deploy-frontend.sh
```

This updates the Lambda authorizer's `API_TOKEN` environment variable to the new token.

#### Step 6 — Re-initialize the vault with the new master password

1. Open the **Manager app** → https://d2xizde5tcfavk.cloudfront.net
2. Enter your **new** master password and click Unlock.
3. Because there is no `vault-meta`, the Manager will create a new one automatically — generating a fresh Argon2 salt and encrypting a new verifier.
4. You will see: *"Master password set. This becomes your permanent master — remember it."*

The new session is now active. Your site configurations (names, categories, unique strings) are unchanged — only the derived passwords are different.

#### Step 7 — Update all site passwords on every website

Since every derived password has changed, you must go to each website and:

1. Log in using the **old** password (which you recorded in Step 1).
2. Change the website password to the **new** derived password (generated by the Vault app with the new master password).

---

### Summary of what changes vs. what stays the same

| Item | Changes? |
|---|---|
| Master password | ✅ Yes — you chose a new one |
| Argon2 vault salt (in DynamoDB) | ✅ Yes — regenerated on re-init |
| API Bearer token | ✅ Yes — regenerated via `gen-token.js` |
| All derived site passwords | ✅ Yes — new K → new passwords |
| Site configurations (names, uniques, categories) | ❌ No — untouched in DynamoDB |
| Site unique strings | ❌ No — unchanged |

---

## 16. Tear-Down

To delete the entire AWS stack:

```bash
aws cloudformation delete-stack --stack-name pmanager
```

> **Warning:** The DynamoDB table has `DeletionPolicy: Retain` — it is **not deleted** when the stack is removed. To delete it manually:
>
> ```bash
> aws dynamodb delete-table --table-name pmanager-pmanager
> ```

S3 buckets must be emptied before CloudFormation can delete them:

```bash
aws s3 rm s3://pmanager-manager-864138843762-pmanager --recursive
aws s3 rm s3://pmanager-vault-864138843762-pmanager --recursive
```

Then delete the stack again.

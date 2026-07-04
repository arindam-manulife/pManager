# AWS Deployment Guide

Full-stack deployment for pManager:
- **Backend** — API Gateway (HTTP API v2) → Lambda (Node.js 24, arm64) → DynamoDB
- **Frontend** — S3 + CloudFront (HTTPS) for Manager and Vault apps

---

## Deployed Resources (current stack: `pmanager`, region: `ca-central-1`)

| Resource | Value |
|----------|-------|
| API URL | `https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com` |
| Lambda Function | `pmanager-api-pmanager` |
| DynamoDB Table | `pmanager-pmanager` |
| Manager S3 Bucket | `pmanager-manager-864138843762-pmanager` |
| Vault S3 Bucket | `pmanager-vault-864138843762-pmanager` |
| **Manager App URL** | **https://d2xizde5tcfavk.cloudfront.net** |
| **Vault App URL** | **https://d28qqey4ujtj4r.cloudfront.net** |

---

## Prerequisites

| Tool | Install |
|------|---------|
| AWS CLI v2 | `brew install awscli` |
| AWS SAM CLI | `brew install aws-sam-cli` |
| Node.js 20+ | `brew install node` |

### macOS SSL fix (one-time)

The AWS CLI on macOS may fail with `SSL: CERTIFICATE_VERIFY_FAILED`. Fix by exporting system certificates:

```bash
security find-certificate -a -p /Library/Keychains/System.keychain > /tmp/aws-ca-bundle.pem
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> /tmp/aws-ca-bundle.pem
echo "ca_bundle = /tmp/aws-ca-bundle.pem" >> ~/.aws/config
```

> `/tmp/aws-ca-bundle.pem` is cleared on reboot — re-run the first two lines after a restart.

---

## Step 1 — Configure AWS credentials

```bash
aws configure
```

| Prompt | Value |
|--------|-------|
| AWS Access Key ID | your IAM access key |
| AWS Secret Access Key | your IAM secret |
| Default region | `ca-central-1` |
| Default output format | `json` |

Verify:

```bash
aws sts get-caller-identity
```

---

## Step 2 — Build

```bash
sam build --template-file aws/template.yaml
```

> The Lambda has no npm dependencies — the `package.json file not found` warning is safe to ignore.

---

## Step 3 — Deploy (first time)

```bash
sam deploy --guided \
  --template-file aws/template.yaml \
  --config-file aws/samconfig.toml
```

Accept the defaults at every prompt. After completion the stack outputs print the API URL, S3 bucket names, and CloudFront URLs.

> CloudFront distributions take **~10 minutes** to propagate globally on first deploy.

---

## Step 4 — Upload frontend files to S3

```bash
aws s3 sync manager/ s3://pmanager-manager-864138843762-pmanager --delete --exclude ".DS_Store"
aws s3 sync vault/   s3://pmanager-vault-864138843762-pmanager   --delete --exclude ".DS_Store"
```

Or use the convenience script (build + deploy + sync in one step):

```bash
bash aws/deploy-frontend.sh
```

---

## Step 5 — Update frontend config (if API URL changes)

Edit **both** `manager/config.js` and `vault/config.js`:

```js
window.PM_CONFIG = {
  apiBase: "https://<api-id>.execute-api.ca-central-1.amazonaws.com",
  useLocalCache: true,
};
```

Then re-sync to S3 (Step 4).

---

## Subsequent deployments

```bash
sam build --template-file aws/template.yaml && \
sam deploy --template-file aws/template.yaml \
           --config-file aws/samconfig.toml \
           --no-confirm-changeset
```

Then re-sync frontend files if any changed (Step 4).

---

## Useful commands

| Command | Description |
|---------|-------------|
| `sam logs -n pmanager-api-pmanager --tail` | Stream live Lambda logs |
| `aws cloudformation describe-stacks --stack-name pmanager` | View stack status and all outputs |
| `aws s3 ls s3://pmanager-manager-864138843762-pmanager` | List uploaded manager files |
| `aws cloudfront create-invalidation --distribution-id <id> --paths "/*"` | Bust CloudFront cache after update |

---

## Stack resources

| Logical ID | AWS Type | Notes |
|------------|----------|-------|
| `PManagerTable` | DynamoDB Table | `DeletionPolicy: Retain` — survives stack deletion |
| `PManagerFunction` | Lambda Function | Node.js 24.x, arm64 (Graviton2), 256 MB |
| `PManagerApi` | API Gateway v2 HTTP API | Routes `/api/{proxy+}` to Lambda |
| `PManagerManagerBucket` | S3 Bucket | Hosts Manager frontend |
| `PManagerVaultBucket` | S3 Bucket | Hosts Vault frontend |
| `PManagerOAC` | CloudFront OAC | Grants CloudFront-only access to S3 buckets |
| `PManagerManagerDistribution` | CloudFront Distribution | HTTPS for Manager app |
| `PManagerVaultDistribution` | CloudFront Distribution | HTTPS for Vault app |
| `PManagerFunctionRole` | IAM Role | DynamoDB CRUD permissions only |

---

## Known issues & fixes

### `sam build` — command not found
SAM CLI not installed. Run `brew install aws-sam-cli`.

### `Unable to locate credentials`
AWS CLI not configured. Run `aws configure` with your IAM access key.

### `SSL: CERTIFICATE_VERIFY_FAILED`
macOS system certificates not trusted. See the macOS SSL fix in Prerequisites above.

### `Cannot reach API: Failed to fetch` (browser)
The HTML is being opened as a `file://` URL. Browsers send `Origin: null` for file:// pages, which API Gateway blocks even with `AllowOrigins: *`. Use the CloudFront URLs, or run a local server:
```bash
python3 -m http.server 8080
# Manager: http://localhost:8080/manager/
# Vault:   http://localhost:8080/vault/
```

### `Cannot read properties of undefined (reading 'verifyMaster')` — Manager only
`derive.js` was referenced via `../vault/derive.js` — a relative path that breaks when served from a separate CloudFront distribution. Fixed by copying `argon2.umd.min.js` and `derive.js` into `manager/` and updating the script tags in `manager/index.html`.

---

## Tear-down

```bash
aws cloudformation delete-stack --stack-name pmanager
```

> The DynamoDB table is **not** deleted (`DeletionPolicy: Retain`). Delete it manually in the AWS Console if you no longer need the data.

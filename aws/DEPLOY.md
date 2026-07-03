# AWS Deployment Guide

Deploys the pManager serverless backend: **API Gateway (HTTP API) → Lambda → DynamoDB**.

---

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | AWS authentication | `brew install awscli` |
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | Build & deploy | `brew install aws-sam-cli` |
| Node.js 20+ | Lambda runtime dependency install | `brew install node` |
| Docker (optional) | SAM local testing | `brew install --cask docker` |

---

## Step 1 — Configure AWS credentials

```bash
aws configure
```

Enter your **Access Key ID**, **Secret Access Key**, default region (`ca-central-1`), and output format (`json`).

Verify access:

```bash
aws sts get-caller-identity
```

---

## Step 2 — Install Lambda dependencies

From the repo root:

```bash
cd aws/lambda
npm install
cd ../..
```

---

## Step 3 — Build the SAM application

```bash
cd aws
sam build
```

SAM compiles the Lambda code and packages it under `.aws-sam/build/`.

---

## Step 4 — Deploy (first time)

Run the guided deploy to create `samconfig.toml` (already committed with defaults):

```bash
sam deploy --guided
```

Prompted values — press **Enter** to accept the defaults shown in brackets:

| Prompt | Default / recommended value |
|--------|-----------------------------|
| Stack Name | `pmanager` |
| AWS Region | `ca-central-1` |
| `AllowedOrigin` | `*` (for local dev) or your frontend URL in production |
| Confirm changeset before deploy | `Y` |
| Allow SAM to create IAM roles | `Y` |
| Save arguments to `samconfig.toml` | `Y` |

> **Production tip:** set `AllowedOrigin` to the exact URL serving your frontend (e.g. `https://mysite.example.com`) to restrict CORS.

---

## Step 5 — Note the stack outputs

After a successful deploy SAM prints the stack outputs:

```
Key                 ApiUrl
Description         API base URL
Value               https://<api-id>.execute-api.ca-central-1.amazonaws.com

Key                 FunctionName
Value               pmanager-api-pmanager

Key                 TableName
Value               pmanager-pmanager
```

Copy the **ApiUrl** value — you will need it in the next step.

---

## Step 6 — Update frontend configuration

Replace the `apiBase` value in **both** frontend config files:

**`manager/config.js`**
```js
window.PM_CONFIG = {
  apiBase: "https://<api-id>.execute-api.ca-central-1.amazonaws.com",
  useLocalCache: true,
};
```

**`vault/config.js`**
```js
window.PM_CONFIG = {
  apiBase: "https://<api-id>.execute-api.ca-central-1.amazonaws.com",
  useLocalCache: true,
};
```

---

## Subsequent deployments

Once `samconfig.toml` exists, deploy without the wizard:

```bash
cd aws
sam build && sam deploy
```

---

## Useful commands

| Command | Description |
|---------|-------------|
| `sam build` | Re-package Lambda code |
| `sam deploy` | Deploy / update the CloudFormation stack |
| `sam logs -n pmanager-api-pmanager --tail` | Stream live Lambda logs |
| `sam local start-api` | Run API locally via Docker |
| `aws cloudformation describe-stacks --stack-name pmanager` | View stack status |
| `aws cloudformation delete-stack --stack-name pmanager` | Delete stack (DynamoDB table is **retained**) |

---

## Stack resources created

| Resource | AWS Type | Notes |
|----------|----------|-------|
| `pmanager-pmanager` | DynamoDB Table | `DeletionPolicy: Retain` — survives stack deletion |
| `pmanager-api-pmanager` | Lambda Function | Node.js 24.x, arm64 (Graviton2) |
| HTTP API | API Gateway v2 | Routes `/api/{proxy+}` to Lambda |
| Execution Role | IAM Role | DynamoDB CRUD permissions only |

---

## Tear-down

```bash
aws cloudformation delete-stack --stack-name pmanager
```

> The DynamoDB table (`pmanager-pmanager`) is **not** deleted because of `DeletionPolicy: Retain`. Delete it manually in the AWS Console if you no longer need the data.

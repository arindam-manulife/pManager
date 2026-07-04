#!/usr/bin/env bash
# deploy-frontend.sh — build, deploy stack, then sync frontend files to S3.
# Run from the repo root: bash aws/deploy-frontend.sh

set -euo pipefail

STACK_NAME="pmanager"
TEMPLATE="/Users/saarind/Documents/GitHub/pManager/aws/template.yaml"
CONFIG="/Users/saarind/Documents/GitHub/pManager/aws/samconfig.toml"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building SAM application..."
sam build --template-file "$TEMPLATE"

echo "==> Deploying stack ($STACK_NAME)..."
sam deploy \
  --template-file "$TEMPLATE" \
  --config-file "$CONFIG" \
  --no-confirm-changeset || true

echo "==> Fetching S3 bucket names from stack outputs..."
MANAGER_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ManagerBucket'].OutputValue" \
  --output text)

VAULT_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='VaultBucket'].OutputValue" \
  --output text)

echo "==> Syncing Manager frontend → s3://$MANAGER_BUCKET"
aws s3 sync "$REPO_ROOT/manager/" "s3://$MANAGER_BUCKET" \
  --delete \
  --exclude ".DS_Store" \
  --cache-control "no-cache, no-store, must-revalidate"

echo "==> Syncing Vault frontend → s3://$VAULT_BUCKET"
aws s3 sync "$REPO_ROOT/vault/" "s3://$VAULT_BUCKET" \
  --delete \
  --exclude ".DS_Store" \
  --cache-control "no-cache, no-store, must-revalidate"

echo ""
echo "==> Done! URLs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ManagerUrl'||OutputKey=='VaultUrl'].[OutputKey,OutputValue]" \
  --output table

echo ""
echo "Note: CloudFront may take ~10 minutes to propagate on first deploy."

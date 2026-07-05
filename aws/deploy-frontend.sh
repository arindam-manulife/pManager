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

echo "==> Fetching CloudFront distribution IDs..."
MANAGER_CF=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ManagerCFDistribution'].OutputValue" \
  --output text 2>/dev/null || echo "")

VAULT_CF=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='VaultCFDistribution'].OutputValue" \
  --output text 2>/dev/null || echo "")

# Fall back to known distribution IDs if not in stack outputs.
MANAGER_CF="${MANAGER_CF:-E3LG7FGZ7FL6RX}"
VAULT_CF="${VAULT_CF:-E3SQ153SFVDDIK}"

echo "==> Invalidating CloudFront cache (Manager: $MANAGER_CF, Vault: $VAULT_CF)..."
aws cloudfront create-invalidation --distribution-id "$MANAGER_CF" --paths "/*" --output text
aws cloudfront create-invalidation --distribution-id "$VAULT_CF"   --paths "/*" --output text

echo ""
echo "==> Done! URLs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ManagerUrl'||OutputKey=='VaultUrl'].[OutputKey,OutputValue]" \
  --output table

echo ""
echo "Note: CloudFront may take ~10 minutes to propagate on first deploy."

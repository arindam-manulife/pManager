#!/usr/bin/env bash
# tests/run.sh — install dependencies and run all tests.
# Run from the repo root: bash tests/run.sh
# Run only unit tests:    bash tests/run.sh unit
# Run only e2e tests:     bash tests/run.sh e2e

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUITE="${1:-all}"

echo ""
echo "==> Installing test dependencies..."
cd "$SCRIPT_DIR"
npm install --silent

# ---- Unit tests (jest) -------------------------------------------------------

if [[ "$SUITE" == "all" || "$SUITE" == "unit" ]]; then
  echo ""
  echo "==> Running unit tests..."
  npm test
fi

# ---- E2E tests (native node:test) --------------------------------------------

if [[ "$SUITE" == "all" || "$SUITE" == "e2e" ]]; then
  echo ""

  if [[ -z "${API_TOKEN:-}" ]]; then
    echo "==> Skipping E2E tests (API_TOKEN not set)."
    echo "    To run E2E tests:"
    echo "      API_TOKEN=\$(node aws/gen-token.js \"your-master-password\") bash tests/run.sh e2e"
  else
    echo "==> Running E2E tests against ${API_URL:-https://5paq7xm6v5.execute-api.ca-central-1.amazonaws.com}..."
    node "$SCRIPT_DIR/e2e/api.test.js"
  fi
fi

echo ""
echo "==> Done."

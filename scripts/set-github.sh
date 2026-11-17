#!/bin/bash
# Stores the GitHub sign-in app's ID and secret in the connector.
set -euo pipefail
cd "$(dirname "$0")/.."
read -rp "GitHub Client ID: " CID
read -rsp "GitHub Client secret (hidden): " CSECRET
echo
printf '%s' "$CID" | npx wrangler secret put GITHUB_CLIENT_ID 2>&1 | grep -E "Success|rror" || true
printf '%s' "$CSECRET" | npx wrangler secret put GITHUB_CLIENT_SECRET 2>&1 | grep -E "Success|rror" || true
unset CSECRET
echo "✓ GitHub sign-in is set up."

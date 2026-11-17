#!/bin/bash
# Asks for the GitHub app's client secret in a Mac pop-up and stores it.
set -uo pipefail
cd "$(dirname "$0")/.."
S=$(osascript \
  -e 'set r to display dialog "Paste the GitHub client secret (40 characters), then click Save." & return & return & "(It shows as dots.)" default answer "" with hidden answer with title "Mail connector: GitHub secret" buttons {"Cancel", "Save"} default button "Save" giving up after 600' \
  -e 'if gave up of r then return ""' \
  -e 'return text returned of r' 2>/dev/null) || { echo "Cancelled."; exit 1; }
S=$(printf '%s' "$S" | tr -d '[:space:]')
echo "Received ${#S} characters."
if ! [[ "$S" =~ ^[0-9a-f]{40}$ ]]; then
  echo "✗ That doesn't look like a GitHub client secret (40 letters and numbers, 0-9 and a-f). Nothing saved."
  exit 1
fi
if printf '%s' "$S" | npx wrangler secret put GITHUB_CLIENT_SECRET >/dev/null 2>&1; then
  echo "✓ GitHub secret saved."
else
  echo "✗ Saving failed."
fi
unset S

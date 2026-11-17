#!/bin/bash
# Asks for a secret in a Mac pop-up, checks its shape, stores it as a Worker secret.
#   scripts/dialog-secret.sh NAME "Prompt to show" ['shape it must match (a regular expression)']
#   e.g. scripts/dialog-secret.sh GITHUB_CLIENT_ID "Paste the GitHub Client ID" '^[A-Za-z0-9.]{10,}$'
set -uo pipefail
cd "$(dirname "$0")/.."
name="$1"; prompt="$2"; shape="${3:-.+}"
S=$(osascript \
  -e "set r to display dialog \"$prompt, then click Save.\" & return & return & \"(It shows as dots.)\" default answer \"\" with hidden answer with title \"Mail connector\" buttons {\"Cancel\", \"Save\"} default button \"Save\" giving up after 600" \
  -e 'if gave up of r then return ""' \
  -e 'return text returned of r' 2>/dev/null) || { echo "Cancelled."; exit 1; }
S=$(printf '%s' "$S" | tr -d '[:space:]')
echo "Received ${#S} characters."
if ! [[ "$S" =~ $shape ]]; then
  echo "✗ That doesn't look right for $name. Nothing saved."
  exit 1
fi
if printf '%s' "$S" | npx wrangler secret put "$name" >/dev/null 2>&1; then
  echo "✓ $name saved."
else
  echo "✗ Saving failed."
fi
unset S

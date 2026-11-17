#!/bin/bash
# One-time: creates the two storage spaces the connector needs in your Cloudflare
# account (a KV namespace for sign-ins, a D1 database for rules and the undo log)
# and writes their ids into wrangler.jsonc. Run after `npx wrangler login`.
# Safe to run again: it skips anything already filled in.
set -uo pipefail
cd "$(dirname "$0")/.."
W=node_modules/.bin/wrangler

if grep -q OAUTH_KV_ID_PLACEHOLDER wrangler.jsonc; then
  echo "Creating the sign-in store (KV)..."
  out=$($W kv namespace create OAUTH_KV </dev/null 2>&1)
  kv=$(printf '%s' "$out" | grep -oE '"?id"?[:=] *"[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1)
  if [ -z "$kv" ]; then echo "✗ Couldn't read the new KV id. Wrangler said:"; echo "$out"; exit 1; fi
  sed -i '' "s/OAUTH_KV_ID_PLACEHOLDER/$kv/" wrangler.jsonc
  echo "✓ KV ready."
else
  echo "✓ KV already set up."
fi

if grep -q STATE_DB_ID_PLACEHOLDER wrangler.jsonc; then
  echo "Creating the rules database (D1)..."
  out=$($W d1 create janet-mail-state </dev/null 2>&1)
  db=$(printf '%s' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$db" ]; then echo "✗ Couldn't read the new database id. Wrangler said:"; echo "$out"; exit 1; fi
  sed -i '' "s/STATE_DB_ID_PLACEHOLDER/$db/" wrangler.jsonc
  echo "✓ Database ready."
else
  echo "✓ Database already set up."
fi

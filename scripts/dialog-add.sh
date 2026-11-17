#!/bin/bash
# Same as add-account.sh, but asks for the app password in a normal Mac
# pop-up window instead of the terminal. The password is never printed.
#   scripts/dialog-add.sh <mailbox id from settings.js>   (or: all)
# Run it with no id to see the list.
set -uo pipefail
cd "$(dirname "$0")/.."
id="${1:-}"
# "all": go through every mailbox in settings.js, one pop-up each.
if [ "$id" = all ]; then
  for m in $(node --input-type=module -e "import {ACCOUNTS} from './src/accounts.js'; console.log(ACCOUNTS.map(a=>a.id).join(' '))"); do
    bash scripts/dialog-add.sh "$m" || echo "Skipped $m."
  done
  exit 0
fi
info=$(MAILBOX_ID="$id" node --input-type=module -e "import {ACCOUNTS} from './src/accounts.js'; const id=process.env.MAILBOX_ID; const a=ACCOUNTS.find(a=>a.id===id); if(!a){console.error('Use one of: '+ACCOUNTS.map(a=>a.id).join(', '));process.exit(1)} console.log(a.secret+' '+a.user+' '+a.label.replace(/ /g,'_'))") || exit 1
read -r secret user label <<<"$info"
label=${label//_/ }

PW=$(osascript \
  -e "set r to display dialog \"Paste the app password for $user, then click Connect.\" & return & return & \"(It shows as dots.)\" default answer \"\" with hidden answer with title \"Connect $label\" buttons {\"Cancel\", \"Connect\"} default button \"Connect\" giving up after 600" \
  -e 'if gave up of r then return ""' \
  -e 'return text returned of r' 2>/dev/null) || { echo "Cancelled."; exit 1; }
PW=$(printf '%s' "$PW" | tr -d '[:space:]')
[ -n "$PW" ] || { echo "No password entered."; exit 1; }
echo "Received ${#PW} characters."

if ! MAIL_PW="$PW" node scripts/try.mjs "$id"; then
  unset PW
  exit 1
fi
if printf '%s' "$PW" | npx wrangler secret put "$secret" >/dev/null 2>&1; then
  echo "✓ Stored. $user is connected."
else
  echo "✗ Saving failed."
fi
unset PW

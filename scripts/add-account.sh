#!/bin/bash
# Add one mailbox: asks for its app password (hidden), checks it works by
# signing in and reading the newest messages, then stores it in the Worker.
#   scripts/add-account.sh <mailbox id from settings.js>
# Run it with no id to see the list.
set -uo pipefail
cd "$(dirname "$0")/.."
id="${1:-}"
info=$(MAILBOX_ID="$id" node --input-type=module -e "import {ACCOUNTS} from './src/accounts.js'; const id=process.env.MAILBOX_ID; const a=ACCOUNTS.find(a=>a.id===id); if(!a){console.error('Use one of: '+ACCOUNTS.map(a=>a.id).join(', '));process.exit(1)} console.log(a.secret+' '+a.user+' '+(a.gmail?'gmail':a.host==='imap.mail.me.com'?'icloud':'other'))") || exit 1
read -r secret user kind <<<"$info"
# Expected length of the app password, by provider (0 = don't check).
case "$kind" in
  icloud) expect=19; shape="xxxx-xxxx-xxxx-xxxx (16 letters and 3 dashes)" ;;
  gmail)  expect=16; shape="16 letters (spaces don't count)" ;;
  *)      expect=0;  shape="" ;;
esac

echo
echo "Paste the app password for $user ONE time, then press Return."
echo "Nothing appears while you paste. That's normal."
while true; do
  read -rsp "> " PW
  echo
  PW=$(printf '%s' "$PW" | tr -d '[:space:]')
  n=${#PW}
  if [ "$n" -eq 0 ]; then
    echo "Nothing came through. Click inside this window, paste, then press Return."
    continue
  fi
  if [ "$expect" -ne 0 ] && [ "$n" -ne "$expect" ]; then
    echo "That was $n characters. An app password here is $expect: $shape."
    echo "It may have been pasted twice. Try once more:"
    continue
  fi
  echo "Got $n characters. Checking it with the mail server..."
  if MAIL_PW="$PW" node scripts/try.mjs "$id"; then
    break
  fi
  echo
  echo "The mail server didn't accept it. Paste it again, or press Control-C to stop."
done

echo "Storing it in the connector..."
if printf '%s' "$PW" | npx wrangler secret put "$secret" >/dev/null 2>&1; then
  echo "✓ $user is connected. You can close this tab."
else
  echo "✗ Saving failed. Tell Claude."
fi
unset PW

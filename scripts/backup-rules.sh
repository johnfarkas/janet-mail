#!/bin/bash
# Daily backup of the sender rules (D1 key "rules") to backups/sender-rules.json
# on this Mac. Run by launchd (see install-rules-backup.sh) or by hand.
# Log: ~/Library/Logs/janet-mail-rules-backup.log
# Sign-in tokens in the same database are deliberately NOT exported.
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
DB=janet-mail-state
LOG="$HOME/Library/Logs/janet-mail-rules-backup.log"
say() { echo "$(date '+%Y-%m-%d %H:%M') $*" >> "$LOG"; }

# Health note: records success or failure in the same D1 database.
beat() {
  local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ "$1" = ok ]; then sql="INSERT OR REPLACE INTO kv (k, v, exp) VALUES ('health:rules-backup:ok', '$now', NULL)"
  else sql="INSERT OR REPLACE INTO kv (k, v, exp) VALUES ('health:rules-backup:fail', '{\"at\":\"$now\",\"note\":\"$2\"}', NULL)"; fi
  node_modules/.bin/wrangler d1 execute "$DB" --remote --command "$sql" >/dev/null 2>>"$LOG" || say "health note failed"
}
trap 'rc=$?; [ $rc -ne 0 ] && beat fail "Mac backup script exited with an error; see the log"' EXIT

raw=$(node_modules/.bin/wrangler d1 execute "$DB" --remote --json \
  --command "SELECT v FROM kv WHERE k='rules'" 2>>"$LOG") || { say "FAIL: could not read rules from Cloudflare"; exit 1; }

mkdir -p backups
printf '%s' "$raw" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const v = JSON.parse(s)[0].results[0]?.v;
    if (!v) { console.error("no rules row yet"); process.exit(1); }
    process.stdout.write(JSON.stringify(JSON.parse(v), null, 2) + "\n");
  });' > backups/sender-rules.json.tmp || { say "FAIL: rules export was empty or unreadable"; rm -f backups/sender-rules.json.tmp; exit 1; }
mv backups/sender-rules.json.tmp backups/sender-rules.json
say "ok: rules saved to backups/sender-rules.json"
beat ok

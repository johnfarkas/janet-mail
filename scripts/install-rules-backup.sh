#!/bin/bash
# Optional: turns on the daily sender-rules backup (9:15pm) on this Mac, then runs it once.
# Undo: launchctl bootout gui/$(id -u)/com.janet-mail.rules-backup
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.janet-mail.rules-backup
LOG="$HOME/Library/Logs/janet-mail-rules-backup.log"
P="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$P" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/scripts/backup-rules.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$P"
launchctl kickstart "gui/$(id -u)/$LABEL"
sleep 20
echo "Daily sender-rules backup is on. Latest result:"
tail -1 "$LOG"

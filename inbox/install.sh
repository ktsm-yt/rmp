#!/bin/bash
# Install the annotation inbox (launchd, 127.0.0.1:8766) and the Claude Code /rmp skill.
#   bash inbox/install.sh            # install or update
#   bash inbox/install.sh uninstall  # remove both and the hooks' registry (received annotations in ~/.rmp-inbox stay)
#   bash inbox/install.sh hooks      # only print the hook wiring for ~/.claude/settings.json
# The hooks are never written into settings.json (the user's harness owns that file): this script
# prints the fragment and the user pastes it.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=local.rmp-inbox
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SKILL="$HOME/.claude/skills/rmp"

# One hook command. It must never block a prompt: a UserPromptSubmit hook that exits 2 blocks every
# prompt, and `python3 <missing file>` exits 2 (the folder was moved, renamed, deleted, or is being
# unzipped over). So skip when the file is gone and end in `|| true` (stdout still reaches Claude).
# The interpreter is the plist's /usr/bin/python3, not whatever python3 the hook's PATH finds.
hook_cmd() {
  # sed, not "${x//pat/rep}": bash 3.2 (/bin/bash on macOS) and bash 4+ / 5.2+ treat the backslashes
  # and quotes of rep differently, and each version broke one of these escapes (2026-10-23).
  local f="$DIR/inbox/rmp-inbox.py" q c
  q="'$(printf '%s' "$f" | sed "s/'/'\\\\''/g")'"         # sh single-quoted path: ' -> '\''
  c="[ -f $q ] && /usr/bin/python3 $q $1 || true"
  printf '%s' "$c" | sed 's/\\/\\\\/g; s/"/\\"/g'    # JSON string escapes: \ -> \\, " -> \"
}

hooks_fragment() {
  local session prompt
  session="$(hook_cmd hook-session)"
  prompt="$(hook_cmd hook-prompt)"
  cat <<JSON
--- 次の入力で知らせる hook (任意): ~/.claude/settings.json の "hooks" に足してください ---
--- (このスクリプトは settings.json を書きません。既に同じ event の hook があれば配列に並べます) ---
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "$session", "timeout": 5 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$prompt", "timeout": 5 } ] }
    ]
  }
}
--- 貼った後に始めた Claude セッションから効きます (送り先のチップの印が [次の入力] になる。動いているセッションに効くかは未確認) ---
--- このフォルダを移す・名前を変える・消す前に、この 2 つの hook を settings.json から外してください ---
JSON
}

if [ "${1:-}" = hooks ]; then
  hooks_fragment
  exit 0
fi

if [ "${1:-}" = uninstall ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$SKILL/SKILL.md"
  # The hooks' registry: an entry left behind would keep a session marked [次の入力] after the hooks
  # are gone (only a SessionStart hook prunes it).
  rm -f "$HOME/.rmp-inbox/sessions/"*.json
  echo "removed the inbox, the /rmp skill and the hooks' session registry"
  echo "hook を ~/.claude/settings.json に貼っていたら、rmp-inbox.py hook-session / hook-prompt の 2 つを手で外してください (このフォルダを消す前に)"
  exit 0
fi

job_pid() {
  (launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || true) |
    awk '/^[[:space:]]*pid = [0-9]+/{gsub(/[^0-9]/, "", $3); print $3; exit}'
}
listener_pids() {
  lsof -nP -t -iTCP:8766 -sTCP:LISTEN 2>/dev/null | sort -u || true
}

job_pid="$(job_pid)"
listener_pids="$(listener_pids)"
if [ -n "$listener_pids" ] && [ "$listener_pids" != "$job_pid" ]; then
  for listener_pid in $listener_pids; do
    command="$( (ps -p "$listener_pid" -o command= 2>/dev/null || true) | sed 's/^[[:space:]]*//')"
    echo "port 8766 is already held by PID $listener_pid${command:+ ($command)}; stop that process before installing" >&2
  done
  exit 1
fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

mkdir -p "$HOME/.rmp-inbox" "$(dirname "$PLIST")" "$SKILL"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$DIR/inbox/rmp-inbox.py</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.rmp-inbox/serve.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sed "s|__RMP_DIR__|$DIR|g" "$DIR/skill/SKILL.md" > "$SKILL/SKILL.md"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  job_pid="$(job_pid)"
  listener_pids="$(listener_pids)"
  [ -n "$job_pid" ] && [ "$listener_pids" = "$job_pid" ] && break
  sleep 0.5
done
if [ -n "$job_pid" ] && [ "$listener_pids" = "$job_pid" ]; then
  echo "ok: inbox listening on 127.0.0.1:8766, skill at $SKILL/SKILL.md"
  echo "next: load $DIR/extension/dist in chrome://extensions (Developer mode → Load unpacked)"
  echo
  hooks_fragment
else
  echo "inbox did not start; see $HOME/.rmp-inbox/serve.log" >&2
  exit 1
fi

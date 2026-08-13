#!/bin/bash
# claude-hub event relay. Called by Claude Code hooks (Notification / Stop).
# No-op unless this session was spawned by the claude-hub app (env vars injected).
[ -z "$CLAUDE_HUB_TAB" ] && exit 0
EVENT="${1:-unknown}"
MSG=$(jq -r '.message // empty' 2>/dev/null)
curl -s -m 2 -X POST "http://127.0.0.1:${CLAUDE_HUB_PORT:-43917}/event" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg tab "$CLAUDE_HUB_TAB" --arg event "$EVENT" --arg msg "$MSG" '{tab:$tab,event:$event,message:$msg}')" \
  >/dev/null 2>&1
exit 0

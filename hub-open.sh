#!/bin/bash
# Ask the claude-hub app to open a Claude session tab for a project.
# Usage: hub-open.sh <project-name> [--resume]
# Only works from a session spawned by the claude-hub app (env vars injected).
PROJECT="$1"
[ -z "$PROJECT" ] && { echo "usage: hub-open.sh <project-name> [--resume]" >&2; exit 1; }
RESUME=false
[ "$2" = "--resume" ] && RESUME=true
curl -s -m 2 -X POST "http://127.0.0.1:${CLAUDE_HUB_PORT:-43917}/open" \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -n --arg p "$PROJECT" --argjson r "$RESUME" '{project:$p,resume:$r}')"
echo

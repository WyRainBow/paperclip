#!/usr/bin/env bash
# Paperclip SessionStart hook: inject a TeamWorkSpace asset directory map
# into the session context (decision mul40.session-injection: inject-
# directory-map, 2000 token cap, index only — no body content).
#
# Output: JSON with hookSpecificOutput.additionalContext for Claude-family
# tools; plain text for others. The map lists Team Rules titles, Team Wiki
# page paths + one-line summaries, TeamSkill names, and hooks status.
# Ends with a recall instruction line.

set -euo pipefail

API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
BUDGET="${PAPERCLIP_INJECT_BUDGET:-2000}"

if [ -z "$COMPANY_ID" ]; then
  exit 0
fi

# Build the directory map (server-side assembled, same recall endpoint but
# with a "directory" mode that returns just titles+paths).
MAP=$(curl -sf --max-time 3 "${API_BASE}/api/companies/${COMPANY_ID}/workspace/recall?q=&mode=directory&budget=${BUDGET}" 2>/dev/null) || exit 0
[ -n "$MAP" ] || exit 0

if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  # Claude-family: additionalContext must be a STRING — extract the map's
  # `text` field and re-serialize, instead of splicing the whole response
  # object in (which fails the hook schema and drops the injection).
  printf '%s' "$MAP" | python3 -c '
import json, sys
try:
    text = json.load(sys.stdin).get("text", "")
except Exception:
    sys.exit(0)
if text:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}, ensure_ascii=False))
' 2>/dev/null || exit 0
else
  # Codex/zcode/grok: plain text to stderr (picked up as context)
  printf '%s' "$MAP" | python3 -c '
import json, sys
try:
    text = json.load(sys.stdin).get("text", "")
except Exception:
    sys.exit(0)
if text:
    print(text, file=sys.stderr)
' || exit 0
fi

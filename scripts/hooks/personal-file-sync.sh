#!/usr/bin/env bash
# Paperclip PostToolUse hook: when a global directive file (CLAUDE.md /
# AGENTS.md) is written or edited, auto-sync it into Paperclip personal
# assets (wiki space "personal") so the version chain stays current.
set -euo pipefail

INPUT=$(cat 2>/dev/null || echo "")

# Only fire on Write/Edit tool calls touching a global md file
if echo "$INPUT" | grep -qE '(CLAUDE\.md|AGENTS\.md)' 2>/dev/null; then
  # Run sync in background — don't block the agent's tool call
  (
    CLI="${PAPERCLIP_CLI:-node /Users/mac/开源工具/paperclip/cli/dist/index.js}"
    C="${PAPERCLIP_COMPANY_ID:-b982ca51-95fb-4ba2-afa6-a3444d6c3c54}"
    for id in $($CLI personal-file list --company-id "$C" --json 2>/dev/null | python3 -c "import json,sys; [print(x['id']) for x in json.load(sys.stdin)]" 2>/dev/null); do
      $CLI personal-file sync --company-id "$C" "$id" --label "auto-sync (hook)" >/dev/null 2>&1 || true
    done
  ) &
fi

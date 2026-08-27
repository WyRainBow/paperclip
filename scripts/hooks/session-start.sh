#!/usr/bin/env bash
# Paperclip SessionStart hook: inject Team Rules full text + asset directory
# into the session context. OV-aligned design (AGPLv3 — pattern reuse only):
# token-based budget (CJK-aware, 10000 token default), injection mirrored
# to ~/.paperclip/last_inject.md for audit.
set -euo pipefail

API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
# Budget in characters (≈ tokens × ~4 for mixed CJK/ASCII)
# OV uses 10000 tokens; we pass a proportional char budget to the endpoint
BUDGET="${PAPERCLIP_INJECT_BUDGET:-10000}"

if [ -z "$COMPANY_ID" ]; then
  exit 0
fi

MAP=$(curl -sf --max-time 3 \
  "${API_BASE}/api/companies/${COMPANY_ID}/workspace/recall?mode=directory&budget=${BUDGET}" 2>/dev/null) || exit 0

if [ -n "$MAP" ]; then
  # Mirror to file for audit (OV pattern: ~/.openviking/last_inject.md)
  MIRROR_DIR="$HOME/.paperclip"
  MIRROR_FILE="${MIRROR_DIR}/last_inject.md"
  mkdir -p "$MIRROR_DIR" 2>/dev/null || true
  echo "$MAP" > "$MIRROR_FILE" 2>/dev/null || true

  # Claude-family: JSON additionalContext
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":${MAP}}}"
  else
    # Codex/zcode/grok: plain text to stderr
    echo "$MAP" >&2
  fi
fi

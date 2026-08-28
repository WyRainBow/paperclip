#!/usr/bin/env bash
# Paperclip SessionStart hook: inject who this session is, then Team Rules full
# text + asset directory, into the session context. OV-aligned design (AGPLv3 —
# pattern reuse only): token-based budget (CJK-aware, 10000 token default),
# injection mirrored to ~/.paperclip/last_inject.md for audit.
set -euo pipefail

API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
# Budget in characters (≈ tokens × ~4 for mixed CJK/ASCII)
# OV uses 10000 tokens; we pass a proportional char budget to the endpoint
BUDGET="${PAPERCLIP_INJECT_BUDGET:-10000}"

if [ -z "$COMPANY_ID" ]; then
  exit 0
fi

# --- this terminal's credential ----------------------------------------------
# Which terminal is running us, from the variables its own app exports. Asking
# each terminal's config to inject the key failed twice (ZCode's settings.json
# env never reaches Bash children, Codex does not pass it to hook subprocesses),
# so the signature comes from the app itself and there is nothing to configure.
# Kept in step with TERMINAL_SIGNATURES in cli/src/commands/client/common.ts.
#
# The key rides the rules request as a bearer token; the server answers with the
# identity line already on the front of the text (MUL-113, decision 7f198bd4).
# No signature means a plain shell, which deliberately gets no identity rather
# than inheriting somebody else's.
KEY_FILE=""
if [ -n "${CLAUDECODE:-}${CLAUDE_CODE_SESSION_ID:-}${CLAUDE_PROJECT_DIR:-}" ]; then
  KEY_FILE="$HOME/.paperclip/keys/claude-terminal"
elif [ -n "${CODEX_SANDBOX:-}" ]; then
  KEY_FILE="$HOME/.paperclip/keys/codex-terminal"
elif [ -n "${ZCODE_BASE_URL:-}" ]; then
  KEY_FILE="$HOME/.paperclip/keys/zcode-terminal"
fi

AUTH_HEADER=""
if [ -n "$KEY_FILE" ] && [ -r "$KEY_FILE" ]; then
  # `echo`-written keys carry a trailing newline that would corrupt the header.
  KEY=$(tr -d '\r\n' < "$KEY_FILE")
  [ -n "$KEY" ] && AUTH_HEADER="Authorization: Bearer ${KEY}"
fi


# The rules fetch may fail; the identity line still has to reach the session,
# so this is deliberately not an early exit.
if [ -n "$AUTH_HEADER" ]; then
  MAP=$(curl -sf --max-time 3 -H "$AUTH_HEADER" \
    "${API_BASE}/api/companies/${COMPANY_ID}/workspace/recall?mode=directory&budget=${BUDGET}" 2>/dev/null) || MAP=""
else
  MAP=$(curl -sf --max-time 3 \
    "${API_BASE}/api/companies/${COMPANY_ID}/workspace/recall?mode=directory&budget=${BUDGET}" 2>/dev/null) || MAP=""
fi

# Identity first, rules after. Both branches build the same string so the two
# terminal families see identical content (MUL-64 regressed once by letting
# them drift, so keep them structurally identical).
INJECT_TEXT=$(printf '%s' "$MAP" | python3 -c '
import json, sys
raw = sys.stdin.read()
text = ""
if raw.strip():
    try:
        payload = json.loads(raw)
        text = payload.get("text") or "" if isinstance(payload, dict) else ""
    except Exception:
        text = ""
print(text, end="")
')

if [ -n "$INJECT_TEXT" ]; then
  # Mirror to file for audit (OV pattern: ~/.openviking/last_inject.md). The
  # mirror carries the identity line too, so an audit shows who the session was
  # told it is, not just what rules it got.
  MIRROR_DIR="$HOME/.paperclip"
  MIRROR_FILE="${MIRROR_DIR}/last_inject.md"
  mkdir -p "$MIRROR_DIR" 2>/dev/null || true
  printf '%s\n' "$INJECT_TEXT" > "$MIRROR_FILE" 2>/dev/null || true

  # Claude-family: additionalContext must be a STRING. Embedding the endpoint's
  # {"mode","text"} object raw nested it here instead, so the fetched Team Rules
  # never reached the session.
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    INJECT_TEXT="$INJECT_TEXT" python3 -c '
import json, os
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": os.environ["INJECT_TEXT"]}}, ensure_ascii=False))
'
  else
    # Codex/zcode/grok: plain text to stderr.
    printf '%s\n' "$INJECT_TEXT" >&2
  fi
fi

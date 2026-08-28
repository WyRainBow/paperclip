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
# Which terminal is running us, named by the registration itself: each terminal
# registers this hook in its own config file, so that file already knows who it
# is and passes the slug as $1.
#
# There is deliberately no environment-sniffing fallback. This script had one,
# and it carried both defects the CLI was just fixed for: it looked for
# CODEX_SANDBOX, which a non-sandboxed Codex never sets, and it matched
# inherited variables, so a Codex spawned from a ZCode shell signed as
# zcode-terminal. Guessing wrong here is worse than not guessing: an
# unrecognized caller is told so, and never borrows a name.
#
# The CLI resolves the same question by walking the process ancestry
# (detectTerminalSlug in cli/src/commands/client/common.ts). This script does
# not repeat that logic — a second copy is what drifted last time — because the
# registration already knows the answer.
#
# The key rides the rules request as a bearer token; the server answers with the
# identity line already on the front of the text (MUL-113, decision 7f198bd4).
TERMINAL_SLUG="${1:-}"

KEY_FILE=""
case "$TERMINAL_SLUG" in
  claude-terminal|codex-terminal|zcode-terminal) KEY_FILE="$HOME/.paperclip/keys/$TERMINAL_SLUG" ;;
esac

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

  # One channel for every terminal: a JSON object on stdout, where
  # additionalContext must be a STRING (embedding the endpoint's {"mode","text"}
  # object raw nested it here instead, and the fetched Team Rules never reached
  # the session).
  #
  # Codex used to get plain text on stderr, and it was silently discarded: the
  # hook ran, the audit mirror held the right content, and the session still had
  # no idea who it was. Codex reads the same hookSpecificOutput contract Claude
  # does — ~/.codex/hooks/global-repo-policy-guard.py is the working proof — so
  # both now emit it (MUL-113).
  INJECT_TEXT="$INJECT_TEXT" python3 -c '
import json, os
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": os.environ["INJECT_TEXT"]}}, ensure_ascii=False))
'
  # ZCode has not been confirmed to read that contract, so it keeps the plain
  # stderr copy as well. Harmless to a terminal that ignores it.
  if [ -z "${CLAUDE_CODE_SESSION_ID:-}${CLAUDE_PROJECT_DIR:-}${CODEX_THREAD_ID:-}" ]; then
    printf '%s\n' "$INJECT_TEXT" >&2
  fi
fi

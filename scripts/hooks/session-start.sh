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

# --- identity line -----------------------------------------------------------
# A session arrives holding its credential but with no idea whose it is, so
# confirming identity used to mean a human asking it to run `whoami` by hand
# (MUL-113). The credential is right here, so resolve it and say so up front.
#
# Every failure is reported rather than skipped: a session that silently starts
# without an identity keeps working as local-board under the wrong name, which
# is the exact failure MUL-104 spent a day chasing. Each cause is worded
# distinctly so the reader knows whether to fix a config, a file, or a key.
resolve_identity_line() {
  local key_file="${PAPERCLIP_API_KEY_FILE:-}"
  local key body http

  if [ -z "$key_file" ]; then
    printf '身份未取到：PAPERCLIP_API_KEY_FILE 未设置（应由本终端的工具配置注入）'
    return
  fi
  if [ ! -r "$key_file" ]; then
    printf '身份未取到：key 文件不可读 %s' "$key_file"
    return
  fi
  # `echo`-written keys carry a trailing newline that would corrupt the header.
  key=$(tr -d '\r\n' < "$key_file")
  if [ -z "$key" ]; then
    printf '身份未取到：key 文件为空 %s' "$key_file"
    return
  fi

  body=$(curl -s --max-time 3 -w '\n%{http_code}' \
    -H "Authorization: Bearer ${key}" \
    "${API_BASE}/api/agents/me" 2>/dev/null) || {
    printf '身份未取到：无法连接 %s' "$API_BASE"
    return
  }
  http=$(printf '%s' "$body" | tail -n 1)
  body=$(printf '%s' "$body" | sed '$d')

  if [ "$http" != "200" ]; then
    printf '%s' "$body" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    message = json.loads(raw).get("error") or raw.strip()
except Exception:
    message = raw.strip()
print("身份未取到：服务端拒绝（HTTP '"$http"'）%s" % (" " + message if message else ""), end="")
' 2>/dev/null || printf '身份未取到：服务端拒绝（HTTP %s）' "$http"
    return
  fi

  printf '%s' "$body" | python3 -c '
import json, sys
try:
    agent = json.load(sys.stdin)
except Exception:
    print("身份未取到：服务端响应无法解析", end=""); sys.exit(0)
name, agent_id = agent.get("name"), agent.get("id")
if not name or not agent_id:
    print("身份未取到：服务端响应缺少 name 或 id", end=""); sys.exit(0)
print("你是 %s（agent id %s）" % (name, agent_id), end="")
' 2>/dev/null || printf '身份未取到：服务端响应无法解析'
}

IDENTITY_LINE=$(resolve_identity_line)

# The rules fetch may fail; the identity line still has to reach the session,
# so this is deliberately not an early exit.
MAP=$(curl -sf --max-time 3 \
  "${API_BASE}/api/companies/${COMPANY_ID}/workspace/recall?mode=directory&budget=${BUDGET}" 2>/dev/null) || MAP=""

# Identity first, rules after. Both branches build the same string so the two
# terminal families see identical content (MUL-64 regressed once by letting
# them drift, so keep them structurally identical).
INJECT_TEXT=$(printf '%s' "$MAP" | IDENTITY_LINE="$IDENTITY_LINE" python3 -c '
import json, os, sys
raw = sys.stdin.read()
text = ""
if raw.strip():
    try:
        payload = json.loads(raw)
        text = payload.get("text") or "" if isinstance(payload, dict) else ""
    except Exception:
        text = ""
identity = os.environ.get("IDENTITY_LINE", "").strip()
print("\n\n".join(part for part in (identity, text) if part), end="")
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

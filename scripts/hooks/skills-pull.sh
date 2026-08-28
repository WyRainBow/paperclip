#!/usr/bin/env bash
# UserPromptSubmit [paperclip] — keep the on-disk team skill projection fresh.
#
# Throttled to one attempt per TTL window and detached, so a long chat does not
# fork a CLI per message. Prints nothing on purpose: UserPromptSubmit stdout is
# injected into the session context.
set -uo pipefail

cat > /dev/null 2>&1 || true

TTL="${PAPERCLIP_SKILLS_PULL_TTL:-30}"
STATE_DIR="${HOME}/.paperclip"
STAMP="${STATE_DIR}/skills-pull.stamp"
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

now=$(date +%s)
if [[ -f "$STAMP" ]]; then
  last=$(cat "$STAMP" 2>/dev/null || printf '0')
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( now - last < TTL )); then
    exit 0
  fi
fi

# Stamp before spawning: throttling attempts is what caps the fork rate, and a
# pull that dies still leaves the next window to try again.
printf '%s' "$now" > "$STAMP" 2>/dev/null || exit 0

if [[ -n "${PAPERCLIP_CLI:-}" ]]; then
  CLI=("${PAPERCLIP_CLI}")
elif [[ -f "${HOOKS_DIR}/../../cli/dist/index.js" ]]; then
  CLI=(node "${HOOKS_DIR}/../../cli/dist/index.js")
elif command -v paperclipai > /dev/null 2>&1; then
  CLI=(paperclipai)
else
  exit 0
fi

# The pull takes its own lock and exits quietly when a peer session holds it.
nohup "${CLI[@]}" skills pull > /dev/null 2>&1 &

exit 0

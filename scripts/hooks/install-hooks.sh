#!/usr/bin/env bash
# Paperclip hook installer — three terminals (claude/codex/zcode), idempotent
# merge with ownership markers (OV-style OPENVIKING_INTEGRATION_ID pattern,
# mechanism 6 from MUL-40 tech-proposal).
#
# Usage: scripts/hooks/install-hooks.sh [--uninstall]
# Env: PAPERCLIP_COMPANY_ID (required), PAPERCLIP_API_BASE (default localhost:3100)

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKER="[paperclip]"
ACTION="install"
[[ "${1:-}" == "--uninstall" ]] && ACTION="uninstall"

if [ -z "${PAPERCLIP_COMPANY_ID:-}" ]; then
  echo "Error: PAPERCLIP_COMPANY_ID is required" >&2
  exit 1
fi

SESSION_START_CMD="PAPERCLIP_COMPANY_ID=${PAPERCLIP_COMPANY_ID} PAPERCLIP_API_BASE=${PAPERCLIP_API_BASE:-http://localhost:3100} ${HOOKS_DIR}/session-start.sh"
BRANCH_CMD="${HOOKS_DIR}/branch-register.sh"
COMMIT_CMD="${HOOKS_DIR}/commit-progress.sh"

# ─── Claude Code: ~/.claude/settings.json ───
install_claude() {
  local f="$HOME/.claude/settings.json"
  [ -f "$f" ] || touch "$f"
  python3 -c "
import json, sys
f = '$f'
d = json.load(open(f))
h = d.setdefault('hooks', {})

def clean(arr):
    return [g for g in arr if not any('$MARKER' in str(x.get('command','')) for x in (g.get('hooks',[]) if isinstance(g, dict) else []))]

if '$ACTION' == 'uninstall':
    for evt in list(h.keys()):
        h[evt] = clean(h[evt])
        if not h[evt]: del h[evt]
else:
    def add(event, cmd, matcher=None):
        h[event] = clean(h.get(event, []))
        entry = {'hooks': [{'type': 'command', 'command': f'{cmd} # $MARKER', 'timeout': 10}]}
        if matcher: entry['matcher'] = matcher
        h[event].append(entry)
    add('SessionStart', '''$SESSION_START_CMD''')
    add('PreToolUse', '''$BRANCH_CMD''', 'Bash')
    add('PostToolUse', '''$COMMIT_CMD''', 'Bash')

json.dump(d, open(f, 'w'), indent=2, ensure_ascii=False)
open(f, 'a').write('\n')
print(f'claude: $ACTION done')
"
}

# ─── Codex: ~/.codex/hooks.json ───
install_codex() {
  local f="$HOME/.codex/hooks.json"
  [ -f "$f" ] || echo '{}' > "$f"
  python3 -c "
import json
f = '$f'
d = json.load(open(f))
h = d.setdefault('hooks', {})

def clean(arr):
    return [g for g in arr if not any('$MARKER' in str(x.get('command','')) for x in (g.get('hooks',[]) if isinstance(g, dict) else []))]

if '$ACTION' == 'uninstall':
    for evt in list(h.keys()):
        h[evt] = clean(h[evt])
        if not h[evt]: del h[evt]
else:
    def add(event, cmd):
        h[event] = clean(h.get(event, []))
        h[event].append({'hooks': [{'type': 'command', 'command': f'{cmd} # $MARKER', 'timeout': 10}]})
    add('SessionStart', '''$SESSION_START_CMD''')
    add('PreToolUse', '''$BRANCH_CMD''')
    add('PostToolUse', '''$COMMIT_CMD''')

json.dump(d, open(f, 'w'), indent=2, ensure_ascii=False)
open(f, 'a').write('\n')
print(f'codex: $ACTION done')
"
}

# ─── Zcode: ~/.zcode/settings.json (same format as Claude) ───
install_zcode() {
  local f="$HOME/.zcode/settings.json"
  [ -f "$f" ] || echo '{}' > "$f"
  python3 -c "
import json
f = '$f'
d = json.load(open(f))
h = d.setdefault('hooks', {})

def clean(arr):
    return [g for g in arr if not any('$MARKER' in str(x.get('command','')) for x in (g.get('hooks',[]) if isinstance(g, dict) else []))]

if '$ACTION' == 'uninstall':
    for evt in list(h.keys()):
        h[evt] = clean(h[evt])
        if not h[evt]: del h[evt]
else:
    def add(event, cmd, matcher=None):
        h[event] = clean(h.get(event, []))
        entry = {'hooks': [{'type': 'command', 'command': f'{cmd} # $MARKER', 'timeout': 10}]}
        if matcher: entry['matcher'] = matcher
        h[event].append(entry)
    add('SessionStart', '''$SESSION_START_CMD''')
    add('PreToolUse', '''$BRANCH_CMD''', 'Bash')
    add('PostToolUse', '''$COMMIT_CMD''', 'Bash')

json.dump(d, open(f, 'w'), indent=2, ensure_ascii=False)
open(f, 'a').write('\n')
print(f'zcode: $ACTION done')
"
}

install_claude
install_codex
install_zcode
echo "Paperclip hooks ${ACTION} complete (claude/codex/zcode)."

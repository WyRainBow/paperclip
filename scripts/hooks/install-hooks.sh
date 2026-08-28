#!/usr/bin/env bash
# Paperclip hook installer — three terminals, idempotent [paperclip] marker merge.
set -euo pipefail
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKER="[paperclip]"
ACTION="install"
[[ "${1:-}" == "--uninstall" ]] && ACTION="uninstall"
CID="${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID required}"
API="${PAPERCLIP_API_BASE:-http://localhost:3100}"

SESSION_CMD="PAPERCLIP_COMPANY_ID=${CID} PAPERCLIP_API_BASE=${API} ${HOOKS_DIR}/session-start.sh"
BRANCH_CMD="${HOOKS_DIR}/branch-register.sh"
COMMIT_CMD="${HOOKS_DIR}/commit-progress.sh"
SYNC_CMD="${HOOKS_DIR}/personal-file-sync.sh"
SKILLS_PULL_CMD="${HOOKS_DIR}/skills-pull.sh"
SKILLS_INJECT_CMD="node ${HOOKS_DIR}/skills-inject.mjs"
FRICTION_CMD="${HOOKS_DIR}/friction-scan.sh"

export HOOKS_DIR MARKER ACTION SESSION_CMD BRANCH_CMD COMMIT_CMD SYNC_CMD
export SKILLS_PULL_CMD SKILLS_INJECT_CMD FRICTION_CMD

python3 <<'PYEOF'
import json, os, sys

ACTION = os.environ["ACTION"]
MARKER = os.environ["MARKER"]
SESSION_CMD = os.environ["SESSION_CMD"]
BRANCH_CMD = os.environ["BRANCH_CMD"]
COMMIT_CMD = os.environ["COMMIT_CMD"]
SYNC_CMD = os.environ["SYNC_CMD"]
SKILLS_PULL_CMD = os.environ["SKILLS_PULL_CMD"]
SKILLS_INJECT_CMD = os.environ["SKILLS_INJECT_CMD"]
FRICTION_CMD = os.environ["FRICTION_CMD"]

def clean(arr):
    return [g for g in arr if not any(MARKER in str(x.get("command","")) for x in (g.get("hooks",[]) if isinstance(g, dict) else []))]

def install(path, fmt, label):
    try:
        d = json.load(open(path))
    except:
        d = {}
    h = d.setdefault("hooks", {})
    if "hooks" in h and isinstance(h["hooks"], dict):
        h = h["hooks"]
        d["hooks"] = h

    if ACTION == "uninstall":
        for evt in list(h.keys()):
            h[evt] = clean(h[evt])
            if not h[evt]: del h[evt]
        json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
        open(path, "a").write("\n")
        return

    def mk(cmd, matcher=None):
        hooks = [{"type": "command", "command": f"{cmd} # {MARKER}", "timeout": 10}]
        if fmt == "claude":
            entry = {"hooks": hooks}
            if matcher: entry["matcher"] = matcher
        else:
            entry = {"hooks": hooks}
        return entry

    # SessionStart
    h["SessionStart"] = clean(h.get("SessionStart", []))
    h["SessionStart"].append(mk(SESSION_CMD))

    # UserPromptSubmit — keeps the team skill projection on disk fresh
    h["UserPromptSubmit"] = clean(h.get("UserPromptSubmit", []))
    h["UserPromptSubmit"].append(mk(SKILLS_PULL_CMD))

    # PreToolUse — clean ONCE then append every hook this event carries.
    # The skill injection is Claude Code only: it is the runtime whose stale
    # symlinked-skill behaviour and additionalContext handling we measured.
    h["PreToolUse"] = clean(h.get("PreToolUse", []))
    h["PreToolUse"].append(mk(BRANCH_CMD, matcher="Bash" if fmt == "claude" else None))
    if label == "claude":
        h["PreToolUse"].append(mk(SKILLS_INJECT_CMD, matcher="Skill"))

    # PostToolUse — two hooks, clean ONCE then append both
    h["PostToolUse"] = clean(h.get("PostToolUse", []))
    h["PostToolUse"].append(mk(COMMIT_CMD, matcher="Bash" if fmt == "claude" else None))
    h["PostToolUse"].append(mk(SYNC_CMD, matcher="Write|Edit" if fmt == "claude" else None))

    # Stop — friction scan (MUL-139): one nudge per session toward
    # `workspace remember` when the transcript was painful enough.
    h["Stop"] = clean(h.get("Stop", []))
    h["Stop"].append(mk(FRICTION_CMD))

    json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")

for path, fmt, label in [
    (os.path.expanduser("~/.claude/settings.json"), "claude", "claude"),
    (os.path.expanduser("~/.codex/hooks.json"), "codex", "codex"),
    (os.path.expanduser("~/.zcode/settings.json"), "claude", "zcode"),
]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        open(path, "w").write("{}")
    install(path, fmt, label)
    print(f"{label}: {ACTION} done")
PYEOF
echo "Paperclip hooks ${ACTION} complete (claude/codex/zcode)."

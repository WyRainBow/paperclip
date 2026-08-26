#!/usr/bin/env bash
# Paperclip PreToolUse hook: remind to register the working branch via
# `issue start` when a git branch command is detected (mechanism from
# MUL-35: opening a branch = registration moment).

set -euo pipefail

# Read the tool input from stdin (Claude Code hook protocol)
INPUT=$(cat 2>/dev/null || echo "")

# Only fire on git branch/checkout/switch commands
if echo "$INPUT" | grep -qE 'git (branch|checkout|switch)' 2>/dev/null; then
  cat <<'MSG'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"开分支了？记得跑 paperclipai issue start <卡号> --branch <分支名> 登记分支和主审会话。"}}
MSG
fi

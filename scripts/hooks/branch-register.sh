#!/usr/bin/env bash
# Paperclip PreToolUse hook: remind to register the working branch via
# `issue start` when a git branch command is detected (mechanism from
# MUL-35: opening a branch = registration moment).

set -euo pipefail

# Read the tool input from stdin (Claude Code hook protocol)
INPUT=$(cat 2>/dev/null || echo "")

# Fire only on real branch CREATION. The old pattern matched every
# branch/checkout/switch mention, so read-only commands (`git branch -a`,
# `git checkout -q <sha> -- file`) tripped it constantly — a reminder that
# cries wolf gets ignored, which is how 15 of 18 started cards ended up with
# nobody registering anything (MUL-59).
# 只塞提醒，不带 permissionDecision：hook 替权限系统说 allow 会在部分模式下被 harness
# 拒为 unsupported，整个 hook 报 failed，提醒也跟着丢。对权限不表态则哪种模式都能送达。
if echo "$INPUT" | grep -qE 'git (checkout -b|switch -c|worktree add)' 2>/dev/null; then
  cat <<'MSG'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"开分支了？记得跑 paperclipai issue start <卡号> --branch <分支名> 登记分支和主审会话。"}}
MSG
fi

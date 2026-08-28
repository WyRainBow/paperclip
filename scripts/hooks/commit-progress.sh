#!/usr/bin/env bash
# Paperclip PostToolUse hook: after a git commit, remind to file a progress
# note on the issue (MUL-35: every round of work earns a progress line).

set -euo pipefail

INPUT=$(cat 2>/dev/null || echo "")

if echo "$INPUT" | grep -qE 'git commit' 2>/dev/null; then
  cat <<'MSG'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"提交了代码。paperclipai issue progress <卡号> \"做了什么、产出在哪\" 落一行进度笔记。如果这轮工作完成了，记得更新 issue 状态。"}}
MSG
fi

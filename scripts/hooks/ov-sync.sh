#!/usr/bin/env bash
# UserPromptSubmit [paperclip] — 把 Paperclip 的团队资产推到 OpenViking（MUL-519 决策 24）。
#
# 照抄 skills-pull.sh 的形状：TTL 内只跑一次、detach、不打印。UserPromptSubmit 的 stdout
# 会注入会话上下文，所以这里必须静默。机器闲着不跑，你一发消息它才查一次有没有新东西。
set -uo pipefail
cat > /dev/null 2>&1 || true
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

TTL="${PAPERCLIP_OV_SYNC_TTL:-1800}"
STAMP="$HOME/.paperclip/ov-sync.trigger.stamp"
mkdir -p "$HOME/.paperclip" 2>/dev/null || exit 0

now=$(date +%s)
if [[ -f "$STAMP" ]]; then
  last=$(cat "$STAMP" 2>/dev/null || printf '0')
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  (( now - last < TTL )) && exit 0
fi
printf '%s' "$now" > "$STAMP" 2>/dev/null || exit 0

nohup /usr/bin/python3 "$(dirname "$0")/../ov-sync/ov-sync.py" > /dev/null 2>&1 &
exit 0

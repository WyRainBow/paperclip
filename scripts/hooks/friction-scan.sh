#!/usr/bin/env bash
# Paperclip Stop hook: friction scan (MUL-139, design borrowed from teamai-cli's
# session-end scorer — formula and thresholds copied, not reinvented; teamai is
# MIT, this is an independent bash+python3 implementation).
#
# Reads the session transcript the terminal hands us on stdin, scores friction
# (interrupts / tool rejections / tool errors), and when the session was
# painful enough prints ONE additionalContext nudge pointing at
# `workspace remember` (MUL-133). The nudge is the passive-trigger half the
# experience loop was missing: remember is HOW a lesson gets filed, this hook
# is WHEN the agent is told it probably owes one.
#
# Contract rules this script lives by:
# - never blocks the session: any failure exits 0 quietly
# - at most one nudge per session (stamp file), matching teamai's hinted flag
# - no transcript path on stdin → silent exit (a missing signal is not a zero
#   score; guessing at paths would misattribute friction to the wrong session)
set -uo pipefail

STDIN_JSON=$(cat 2>/dev/null || true)

STATE_DIR="${HOME}/.paperclip/friction"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

FRICTION_JSON="$STDIN_JSON" python3 <<'PYEOF'
import json, os, sys, re

try:
    payload = json.loads(os.environ.get("FRICTION_JSON", "") or "{}")
except Exception:
    sys.exit(0)
if not isinstance(payload, dict):
    sys.exit(0)

transcript_path = payload.get("transcript_path") or ""
session_id = payload.get("session_id") or payload.get("sessionId") or ""
if not transcript_path or not os.path.isfile(transcript_path):
    # Without a transcript there is nothing to score. Codex and zcode may not
    # hand one over on Stop; staying silent is correct there (see MUL-139
    # tech-proposal: no path-p guessing).
    sys.exit(0)

# teamai's SMART_THRESHOLD=20 with BASE_THRESHOLD=15 tool uses: a short session
# cannot cross the bar no matter how noisy, and a long clean session never
# scores. Same numbers, same meaning.
SMART_THRESHOLD = 20
BASE_TOOL_COUNT = 15

interrupts = 0
rejections = 0
tool_errors = 0
tool_count = 0

REJECT_MARKERS = (
    "The tool use was rejected",
    "tool use was not executed",
    "the user doesn't want to proceed",
    "didn't respond",
)
INTERRUPT_MARKER = "[Request interrupted by user"

try:
    with open(transcript_path, "r", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                # Bare-text lines can still carry the interrupt marker even
                # when the surrounding JSONL is malformed.
                if INTERRUPT_MARKER in line:
                    interrupts += 1
                continue
            if not isinstance(entry, dict):
                continue

            msg = entry.get("message")
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "tool_use":
                            tool_count += 1
                elif isinstance(content, str):
                    if INTERRUPT_MARKER in content:
                        interrupts += 1
                    elif any(m in content for m in REJECT_MARKERS):
                        rejections += 1

            # Rejections also arrive as tool_result entries (content blocks of
            # type tool_result whose text says the user refused), and errors as
            # toolUseResult.is_error — count both shapes.
            result = entry.get("toolUseResult")
            if isinstance(result, dict) and result.get("is_error"):
                tool_errors += 1
            elif isinstance(result, str) and any(m in result for m in REJECT_MARKERS):
                rejections += 1

            text_blob = entry.get("text") or ""
            if isinstance(text_blob, str):
                if INTERRUPT_MARKER in text_blob:
                    interrupts += 1
                elif any(m in text_blob for m in REJECT_MARKERS):
                    rejections += 1
except OSError:
    sys.exit(0)

# teamai's tool-error tiers (dist/index.js:587-603): 8+ → 25, 5+ → 18, 3+ → 10.
if tool_errors >= 8:
    error_points = 25
elif tool_errors >= 5:
    error_points = 18
elif tool_errors >= 3:
    error_points = 10
else:
    error_points = 0

score = interrupts * 20 + rejections * 20 + error_points
if score < SMART_THRESHOLD or tool_count < BASE_TOOL_COUNT:
    sys.exit(0)

stamp = os.path.join(
    os.environ.get("HOME", os.path.expanduser("~")),
    ".paperclip",
    "friction",
    re.sub(r"[^A-Za-z0-9._-]", "_", session_id or os.path.basename(transcript_path)) + ".stamp",
)
if os.path.exists(stamp):
    sys.exit(0)

nudge = (
    f"[paperclip] 本会话摩擦分 {score}（中断 {interrupts} / 拒绝 {rejections} / 工具错误 {tool_errors}，工具调用 {tool_count} 次），"
    "可能有值得沉淀的经验。若这是可复用的模式（不是一次性事故），收尾前跑一次：\n"
    "paperclipai workspace remember --title <模式名> --situation <何时适用> --approach <正确做法> --reflect <硬性禁止>"
)
try:
    with open(stamp, "w") as fh:
        fh.write(f"score={score} interrupts={interrupts} rejections={rejections} errors={tool_errors} tools={tool_count}\n")
except OSError:
    pass

print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": nudge}}, ensure_ascii=False))
PYEOF

exit 0

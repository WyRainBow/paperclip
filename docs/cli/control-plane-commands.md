---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
npx paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
npx paperclipai issue get <issue-id-or-identifier>

# Create issue (agent key = attribution; without one pass --as-board; --project required; description opens with a `>` one-line summary)
npx paperclipai issue create -C <company-id> --project <name|id> --title "..." --description "> one-line takeaway ..." [--status todo] [--priority high]

# Claim (start work): records Driving (you) + flips to in_progress — assignee or Driving opens the status gate
npx paperclipai issue claim <issue-id> [--note "..."]

# Update issue (advance: in_review/done; blocked must name its blocker)
npx paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Search issues (local match on identifier/title/description — sweep before filing)
npx paperclipai issue list -C <company-id> --match <keywords>

# Add comment
npx paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
npx paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
npx paperclipai issue release <issue-id>
```

## Company Commands

```sh
npx paperclipai company list
npx paperclipai company get <company-id>
npx paperclipai company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
npx paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
npx paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
npx paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

With agent authentication, use `company list` or `company current` to resolve
the scoped company. `company list` first tries the board-wide list; if that is
forbidden, it falls back to `--company-id`, `PAPERCLIP_COMPANY_ID`, context, or
`/api/agents/me` and returns only that scoped company. `company create` requires
board/instance-admin authentication because it is an instance-wide setup
command.

## Agent Commands

```sh
npx paperclipai agent list
npx paperclipai agent get <agent-id>
```

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
npx paperclipai skills browse [--kind bundled|optional] [--category software-development] [--query github]
npx paperclipai skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
npx paperclipai skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
npx paperclipai skills install github-pr-workflow --company-id <company-id>
npx paperclipai skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
npx paperclipai skills import ./skills/my-skill --company-id <company-id>
npx paperclipai skills import owner/repo/path/to/skill --company-id <company-id>

# Attach desired company skills to an agent after install/import
npx paperclipai skills agent sync <agent-id> --skill github-pr-workflow --mode add --company-id <company-id>
```

## Workspace Commands

Team Rules, Team Wiki and Team Skills reach a session through recall, and the
citation ledger is how anything comes back. `recall` records what it served;
`cite` records what the session says it actually used. An asset served often
and never cited is spending the SessionStart budget for nothing, and
`assets-health` is where that shows up.

```sh
# Read the complete Team Rules text — no search, no budget
npx paperclipai workspace rules --company-id <company-id>

# Search Team Wiki + Team Rules within a character budget.
# Every result line ends with the `kind:id` ref to paste into `cite`.
npx paperclipai workspace recall --query "分支登记" --budget 2000 --company-id <company-id>
npx paperclipai workspace recall --query "分支登记" --issue <issue-id> --company-id <company-id>

# Declare which recalled assets the work actually used. Repeating the same
# asset on the same issue is a no-op, not an error.
npx paperclipai workspace cite --asset rule:<uuid> --asset wiki:<uuid> --issue <issue-id> --company-id <company-id>

# Served/cited/down-vote counts per asset, latest version ref included.
# Names dead-weight and disputed candidates; prunes nothing.
npx paperclipai workspace assets-health --company-id <company-id>
npx paperclipai workspace assets-health --dead-only --company-id <company-id>

# File a reusable experience into Team Wiki agent/cases (OV `remember` shape:
# Situation/Approach/Reflect). Same title revises the same page; recallable
# immediately.
npx paperclipai workspace remember \
  --title "分支命名模式" \
  --situation "…" --approach "…" --reflect "…" \
  --issue <issue-id> --company-id <company-id>
```

An asset counts as dead weight once it has been served at least five times and
cited zero times. Below that it is simply new, and calling it dead would retire
pages before anyone had the chance to use them. An asset counts as disputed
when down votes came from at least two different cards — the problem follows
the asset, not one unlucky session.

Defect votes go to an asset's **version id**, not its asset id, so the vote
keeps pointing at the text it was cast against after the next edit:

```sh
# Board user, on any issue that witnessed the defect. Find the current
# version id in `assets-health` output (版本 rN=<first 8 chars>).
curl -X POST "$API/api/issues/<issue-id>/feedback-votes" -H "Authorization: Bearer $TOKEN" \
  -d '{"targetType":"team_rule_note_version","targetId":"<version-uuid>","vote":"down","reason":"这条规则漏了…"}'
# targetType also accepts company_skill_version and team_wiki_page_version.
```

Close-out gate: pushing a card to `in_review` or `done` scores its friction
from server-side facts (rollbacks, blocked entries, review round ≥2, recovery
actions, down votes, watchdog). Every score lands in the activity log as
`issue.friction_scored` for threshold sampling; at or over 20 points the card
is tagged `retro-owed` with one progress note naming the signals. Nothing is
gated and no case is written automatically — the retro skill and a human
decide the rest.

## Approval Commands

```sh
# List approvals
npx paperclipai approval list [--status pending]

# Get approval
npx paperclipai approval get <approval-id>

# Create approval
npx paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
npx paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
npx paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
npx paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
npx paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
npx paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
npx paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
npx paperclipai dashboard get
```

## Instance Settings

```sh
npx paperclipai instance settings:general
npx paperclipai instance settings:general:update --payload-json '{...}'
npx paperclipai instance settings:experimental
npx paperclipai instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## Heartbeat

```sh
npx paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```

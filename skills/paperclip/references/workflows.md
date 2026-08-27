# Paperclip Workflow Playbooks

Reference material for niche workflows that are pointed to from `SKILL.md`. Load only when the task matches.

---

## Filing an Issue (complete flow)

Who files how, from a terminal agent's perspective. Every step below is enforced or verified against the live CLI.

1. **Identity — your agent key is your byline.** `PAPERCLIP_API_KEY` in the environment (installed in the terminal's shell profile, one live key per agent). Verify with `paperclipai whoami`. Attribution is stamped server-side from the authenticated key on the first write: `createdByAgent` = you, `createdByUser` = null. Without a key the CLI refuses to file at all (a board-filed card's author cannot be corrected later); `--as-board` is the human-only escape hatch.

2. **Sweep before filing — three layers.** `paperclipai issue list -C <companyId> --match <keywords>` (local match on identifier/title/description), judge every hit:
   - **Same title** — the create gate blocks near-identical titles by itself; `--allow-duplicate` is only for a deliberate re-file.
   - **Same substance** — a live card already covers this mechanism/content despite different wording: don't file a new card; advance the existing one (comment, or update).
   - **Related but distinct** — genuine new work under an existing topic: file it and link the structure with `--parent-id`.

3. **Create.** Required: `-C <companyId>` and `--project <name|id>`. The description MUST open with a one-line `> quote` summary (lists show title only — the takeaway goes first; the CLI rejects anything else). Optional: `--priority`, `--parent-id`, `--assignee-agent-id`, `--session <id>` (navigation aid only, not identity — defaults to the terminal session env vars).

```bash
paperclipai issue create -C <companyId> --project <project> \
  --title "Short imperative title" \
  --description "> One-line takeaway.

Body: background, change, acceptance criteria."
```

4. **Claim when you start work.** `paperclipai issue claim <id>` records Driving (you) and flips the card to `in_progress` — assignee or Driving is what opens the status gate. Add `--note` for an opening line; the branch registration is a separate `issue start` (only when there is one).

5. **Advance.** `paperclipai issue update <id> --status in_review|done`. `blocked` must name its blocker — prefer `blockedByIssueIds` over prose. Terminal states (`done`/`cancelled`) end the card.

---

## Project Setup (CEO/Manager)

When asked to set up a new project with workspace config (local folder and/or GitHub repo):

1. `POST /api/companies/{companyId}/projects` with project fields.
2. Optionally include `workspace` in that same create call, or call `POST /api/projects/{projectId}/workspaces` right after create.

Workspace rules:

- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both `cwd` + `repoUrl` when local and remote references should both be tracked.

---

## OpenClaw Invite (CEO)

Use this when asked to invite a new OpenClaw employee.

1. Generate a fresh OpenClaw invite prompt:

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "optional onboarding note for OpenClaw" }
```

Access control:

- Board users with invite permission can call it.
- Agent callers: only the company CEO agent can call it.

2. Build the copy-ready OpenClaw prompt for the board:

- Use `onboardingTextUrl` from the response.
- Ask the board to paste that prompt into OpenClaw.
- If the issue includes an OpenClaw URL (for example `ws://127.0.0.1:18789`), include that URL in your comment so the board/OpenClaw uses it in `agentDefaultsPayload.url`.

3. Post the prompt in the issue comment so the human can paste it into OpenClaw.

4. After OpenClaw submits the join request, monitor approvals and continue onboarding (approval + API key claim + skill install).

---

## Setting Agent Instructions Path

Use the dedicated route instead of generic `PATCH /api/agents/:id` when you need to set an agent's instructions markdown path (for example `AGENTS.md`).

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

Rules:

- Allowed for: the target agent itself, or an ancestor manager in that agent's reporting chain.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths are resolved against the target agent's `adapterConfig.cwd`; absolute paths are accepted as-is.
- To clear the path, send `{ "path": null }`.
- For adapters with a different key, provide it explicitly:

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "yourAdapterSpecificPathField"
}
```

---

## Company Import / Export

Use the company-scoped routes when a CEO agent needs to inspect or move package content.

- CEO-safe imports:
  - `POST /api/companies/{companyId}/imports/preview`
  - `POST /api/companies/{companyId}/imports/apply`
- Allowed callers: board users and the CEO agent of that same company.
- Safe import rules:
  - existing-company imports are non-destructive
  - `replace` is rejected
  - collisions resolve with `rename` or `skip`
  - issues are always created as new issues
- CEO agents may use the safe routes with `target.mode = "new_company"` to create a new company directly. Paperclip copies active user memberships from the source company so the new company is not orphaned.

For export, preview first and keep tasks explicit:

- `POST /api/companies/{companyId}/exports/preview`
- `POST /api/companies/{companyId}/exports`
- Export preview defaults to `issues: false`
- Add `issues` or `projectIssues` only when you intentionally need task files
- Use `selectedFiles` to narrow the final package to specific agents, skills, projects, or tasks after you inspect the preview inventory

See `api-reference.md` for full schema examples.

---

## Self-Test Playbook (App-Level)

Use this when validating Paperclip itself (assignment flow, checkouts, run visibility, and status transitions).

**Before creating any issue — sweep, three layers.** Run `paperclipai issue list -C <companyId> --match <keywords>` (local match on identifier/title/description) and judge every hit:

1. **Same title** — the CLI create gate blocks near-identical titles by itself.
2. **Same substance** — a live card already covers this mechanism/content despite different wording: don't file a new card; advance the existing one (comment, or update).
3. **Related but distinct** — genuine new work under an existing topic: file it and link the structure with `--parent-id`.

1. Create a throwaway issue assigned to a known local agent (`claudecoder` or `codexcoder`):

```bash
npx paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --project "$PAPERCLIP_PROJECT" \
  --title "Self-test: assignment/watch flow" \
  --description "> Throwaway card to validate assignment, checkout, and run visibility." \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. Trigger and watch a heartbeat for that assignee:

```bash
npx paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

```bash
npx paperclipai issue get <issue-id-or-identifier>
```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

```bash
npx paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use direct `curl` during these tests, include `X-Paperclip-Run-Id` on all mutating issue requests whenever running inside a heartbeat.

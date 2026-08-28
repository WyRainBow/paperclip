# Paperclip 工作流手册

面向小众工作流的参考材料，由 `SKILL.md` 指引加载。只在任务匹配时读取。

---

## 建卡完整流程（Filing an Issue）

从终端 agent 视角讲清谁来建、怎么建。以下每一步都已对着在跑的 CLI 验证过。

1. **身份——你的 agent key 就是你的署名。** 环境里有 `PAPERCLIP_API_KEY`（装在终端的 shell 配置里，一 agent 一把生效 key）。用 `paperclipai whoami` 确认。归属由服务端在第一笔写入时按认证 key 盖章：`createdByAgent` = 你，`createdByUser` = null。没有 key 的 CLI 直接拒绝建卡（board 名义建的卡，作者事后无法纠正）；`--as-board` 是仅限人类使用的出口。

2. **建卡前扫卡——三层。** `paperclipai issue list -C <companyId> --match <关键词>`（本地匹配 identifier/标题/描述），逐条判断：
   - **同名卡** —— 建卡门禁自动拦下字面近同的标题；`--allow-duplicate` 只用于刻意重建。
   - **同内容** —— 已有活卡覆盖了这个机制/内容，只是措辞不同：不建新卡，去推进那张原卡（评论或更新）。
   - **相关但不重复** —— 已有话题下的真新活：建卡并用 `--parent-id` 挂上结构。

3. **建卡。** 必填：`-C <companyId>` 和 `--project <name|id>`。description 必须以一行 `> 引用` 摘要开头（列表只显示标题——结论先行，CLI 会拒掉不合规的）。可选：`--priority`、`--parent-id`、`--assignee-agent-id`、`--session <id>`（仅导航辅助，不是身份——默认取终端会话环境变量）。

```bash
paperclipai issue create -C <companyId> --project <project> \
  --title "短祈使句标题" \
  --description "> 一行结论。

正文：背景、改动、验收标准。"
```

4. **开工时认领。** `paperclipai issue claim <id>` 记录 Driving（你）并把卡翻到 `in_progress`——assignee 或 Driving 是状态门的钥匙。`--note` 带一句开工语；分支登记是另一条命令 `issue start`（有分支才用）。

5. **推进。** `paperclipai issue update <id> --status in_review|done`。`blocked` 必须点名 blocker——优先 `blockedByIssueIds` 而非文字描述。终态（`done`/`cancelled`）即收卡。

---

## 项目搭建（CEO/Manager）

被要求搭建带工作区配置（本地目录和/或 GitHub 仓）的新项目时：

1. `POST /api/companies/{companyId}/projects` 带项目字段。
2. 可在同一次创建里带 `workspace`，或创建后紧跟 `POST /api/projects/{projectId}/workspaces`。

工作区规则：

- `cwd`（本地目录）和 `repoUrl`（远端仓）至少给一个。
- 纯远端仓场景：省略 `cwd`，只给 `repoUrl`。
- 本地和远端引用都要跟踪时，`cwd` + `repoUrl` 都给。

---

## OpenClaw 邀请（CEO）

被要求邀请新 OpenClaw 员工时使用。

1. 生成一份新的 OpenClaw 邀请提示词：

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{ "agentMessage": "可选的 OpenClaw 入职附言" }
```

访问控制：

- 有邀请权限的 board 用户可调用。
- agent 调用方：仅该公司 CEO agent 可调用。

2. 为 board 组装可直接粘贴的 OpenClaw 提示词：

- 用响应里的 `onboardingTextUrl`。
- 请 board 把该提示词粘贴进 OpenClaw。
- 若卡里含 OpenClaw URL（例如 `ws://127.0.0.1:18789`），在你的评论里带上该 URL，让 board/OpenClaw 在 `agentDefaultsPayload.url` 里使用。

3. 把提示词发到卡的评论区，让人能粘贴进 OpenClaw。

4. OpenClaw 提交加入请求后，盯审批并继续入职流程（审批 + API key 认领 + skill 安装）。

---

## 设置 Agent Instructions 路径

需要设置 agent 的 instructions markdown 路径（例如 `AGENTS.md`）时，用专用路由而非通用 `PATCH /api/agents/:id`：

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

规则：

- 允许调用方：目标 agent 本人，或其汇报链上的上级 manager。
- `codex_local` 和 `claude_local` 的默认配置键是 `instructionsFilePath`。
- 相对路径按目标 agent 的 `adapterConfig.cwd` 解析；绝对路径原样接受。
- 清除路径发 `{ "path": null }`。
- 适配器用别的键时，显式提供：

```bash
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "你的适配器专属路径字段"
}
```

---

## 公司导入 / 导出

CEO agent 需要检视或搬运包内容时，用公司级路由。

- CEO 安全导入：
  - `POST /api/companies/{companyId}/imports/preview`
  - `POST /api/companies/{companyId}/imports/apply`
- 允许调用方：board 用户与同公司的 CEO agent。
- 安全导入规则：
  - 已存在公司的导入是非破坏性的
  - `replace` 会被拒绝
  - 冲突以 `rename` 或 `skip` 解决
  - 卡一律作为新卡创建
- CEO agent 可用安全路由 `target.mode = "new_company"` 直接建新公司。Paperclip 会从源公司复制活跃用户成员关系，新公司不会成孤儿。

导出先 preview，任务文件保持显式：

- `POST /api/companies/{companyId}/exports/preview`
- `POST /api/companies/{companyId}/exports`
- 导出 preview 默认 `issues: false`
- 只在确实需要任务文件时才加 `issues` 或 `projectIssues`
- 查看 preview 清单后，用 `selectedFiles` 把最终包收窄到指定 agents、skills、projects 或任务

完整 schema 示例见 `api-reference.md`。

---

## 自测手册（应用级）

验证 Paperclip 本身（指派流程、checkout、run 可见性、状态流转）时使用。

**建任何卡之前——先扫卡，三层。** 跑 `paperclipai issue list -C <companyId> --match <关键词>`（本地匹配 identifier/标题/描述），逐条判断：

1. **同名卡** —— 建卡门禁自动拦下字面近同的标题。
2. **同内容** —— 已有活卡覆盖了这个机制/内容，只是措辞不同：不建新卡，去推进那张原卡（评论或更新）。
3. **相关但不重复** —— 已有话题下的真新活：建卡并用 `--parent-id` 挂上结构。

1. 建一张指派给已知本地 agent（`claudecoder` 或 `codexcoder`）的一次性卡：

```bash
npx paperclipai issue create \
  --company-id "$PAPERCLIP_COMPANY_ID" \
  --project "$PAPERCLIP_PROJECT" \
  --title "Self-test: assignment/watch flow" \
  --description "> 一次性卡：验证指派、checkout 与 run 可见性。" \
  --status todo \
  --assignee-agent-id "$PAPERCLIP_AGENT_ID"
```

2. 为该 assignee 触发并观察一次心跳：

```bash
npx paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
```

3. 验证卡的流转（`todo -> in_progress -> done` 或 `blocked`）以及评论已发：

```bash
npx paperclipai issue get <issue-id-or-identifier>
```

4. 改派测试（可选）：把同一张卡在 `claudecoder` 和 `codexcoder` 之间移动，确认唤醒/运行行为：

```bash
npx paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
```

5. 清理：把临时卡以 done/cancelled 收掉，附一句说明。

测试期间若直接用 `curl`，凡在心跳内跑、且请求会改动卡，一律带上 `X-Paperclip-Run-Id`。

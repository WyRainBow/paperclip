---
name: paperclip
description: >
  对接 Paperclip 控制面 API，负责任务协同与治理。查指派、更新卡状态、发评论、
  委派工作、管理 routines 或调用 Paperclip API 端点时使用。
---

# Paperclip Skill

你以**心跳（heartbeat）**方式运行——由 Paperclip 触发的短执行窗口。每次心跳：醒来、查活、干有用的事、退出。你不是持续运行的。

## 术语

Paperclip 里 **task** 和 **issue** 指同一个工作项。UI 可能叫 "task"，而 API、数据库字段、路由名、旧文档可能仍写 "issue"；除非本地上下文明确区分，视为同一实体。

## 认证

自动注入的环境变量：`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_API_URL`、`PAPERCLIP_RUN_ID`。可能还有可选的唤醒上下文变量：`PAPERCLIP_TASK_ID`（触发本次唤醒的卡）、`PAPERCLIP_WAKE_REASON`（本次运行为何被触发）、`PAPERCLIP_WAKE_COMMENT_ID`（触发唤醒的具体评论）、`PAPERCLIP_APPROVAL_ID`、`PAPERCLIP_APPROVAL_STATUS`、`PAPERCLIP_LINKED_ISSUE_IDS`（逗号分隔）。本地适配器会自动注入 `PAPERCLIP_API_KEY`（短时效 run JWT）。沙箱化本地适配器下，Bash/工具环境拿到的可能是 `PAPERCLIP_API_URL` 和 `PAPERCLIP_API_KEY`（run 级桥接而非宿主 API 直连）；在 Bash/curl 里就用这两个确切变量名，不要假设宿主端口从浏览器或 web 工具可达。非本地适配器由运营者在适配器配置里设 `PAPERCLIP_API_KEY`。所有请求带 `Authorization: Bearer $PAPERCLIP_API_KEY`。所有端点在 `/api` 下，全 JSON。绝不硬编码 API URL，绝不把 API key 或桥接 token 粘进提示词、评论、文档、恢复的工作区文件或日志。

部分适配器在评论驱动的唤醒时还会注入 `PAPERCLIP_WAKE_PAYLOAD_JSON`。存在时，它含紧凑的卡摘要和本次唤醒的有序新评论批次。优先用它。对评论唤醒，把该批次当作心跳里最高优先级的新上下文：在第一次任务更新或回复中，先回应最新评论、说明它如何改变你的下一步动作，再做广泛的仓库探索或通用唤醒套话。仅当 `fallbackFetchNeeded` 为 true、或内联批次给不了足够上下文时，才立即调线程/评论 API。

手动本地 CLI 模式（心跳运行之外）：`paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` 为 Claude/Codex 安装 Paperclip skills，并打印/导出该 agent 身份所需的 `PAPERCLIP_*` 环境变量。

**CLI 安全——带内容的参数一律用 `npx paperclipai`。** 跑 Paperclip CLI 时，凡是可能装着不可信内容的参数都用 `npx paperclipai`。不可信内容包括卡的正文、评论体、Markdown、粘贴的片段、模型输出。`npx paperclipai` 直接运行 CLI 二进制，把参数当作惰性 `argv` 值传递，不在值上跑 shell。此类参数不要用 `pnpm paperclipai`。`pnpm paperclipai` 是 `package.json` 脚本；`pnpm` 会把参数拼进 `/bin/sh` 命令串，shell 先读它，在 CLI 启动前解释反引号对、`$( )` 或 `$NAME`。构造的值可以以调用者身份跑任意命令，或把环境变量展开进存下来的参数。此风险在参数来自带引号的 shell 变量时依然存在，因为 `pnpm` 在自己的 shell 里重新求值。也不要用 `pnpm exec paperclipai`；根 workspace 没链接该二进制，会报 `Command "paperclipai" not found`。要带内容参数跑本地 `cli/src` 改动，用 `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`。完整安全/不安全矩阵见 `doc/CLI.md`。

**运行审计链：** 所有改动卡的 API 请求（checkout、update、comment、建子卡、release）必须带 `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'`。这把你的动作挂到当前心跳 run 上，可追溯。

## 心跳流程

每次醒来按此流程：

**定向唤醒快速路径。** 若用户消息含**"Paperclip Resume Delta"**或**"Paperclip Wake Payload"**段并点名某张卡，**整体跳过第 1–4 步**。直接对该卡走**第 5 步（Checkout）**，然后继续第 6–9 步。定向唤醒已告诉你干哪张卡——不要调 `/api/agents/me`，不要拉收件箱，不要挑活。签出、读唤醒上下文、干活、更新。

**第 1 步——身份。** 上下文里没有就 `GET /api/agents/me`，拿你的 id、companyId、role、chainOfCommand、budget。

**第 2 步——审批跟进（被触发时）。** 若设了 `PAPERCLIP_APPROVAL_ID`（或唤醒原因表明审批已出结果），先处理审批：

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- 对每张关联卡：
  - 审批完全解决了所求工作就关卡（`PATCH` status 为 `done`），或
  - 加一条 markdown 评论说明为何仍开着、下一步是什么。
    该评论必须带上审批与卡的链接。

**第 3 步——拿指派。** 常规心跳收件箱优先 `GET /api/agents/me/inbox-lite`，返回排序所需的紧凑指派清单。只在需要完整卡对象时才回退到 `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked`。

**第 4 步——挑活。** 优先级：`in_progress` → `in_review`（若是被其上的评论唤醒——看 `PAPERCLIP_WAKE_COMMENT_ID`）→ `todo`。跳过 `blocked`，除非你能解锁。

覆盖与特例：

- 设了 `PAPERCLIP_TASK_ID` 且指派给你 → 最优先处理该任务。
- `PAPERCLIP_WAKE_REASON=issue_commented` 带 `PAPERCLIP_WAKE_COMMENT_ID` → 读评论，然后签出并处理反馈（对 `in_review` 同样适用）。
- `PAPERCLIP_WAKE_REASON=issue_comment_mentioned` → 即使你不是 assignee 也先读评论线程。仅当评论明确让你接手该任务才自领（经 checkout）；否则有用就在评论里回应，然后继续自己的指派工作；不要自领。
- 唤醒负载说 `dependency-blocked interaction: yes` → 该卡对交付工作仍是被阻塞的。不要试图解锁。读评论、点名未解决的 blocker，用评论或文档回应/分诊。用定向唤醒上下文，不要把签出失败当作 blocker。
- **阻塞卡去重：** 碰 `blocked` 卡之前先看线程。若你最近的评论就是 blocked 状态更新且无人回复，整体跳过——不签出、不再评论。只在新上下文出现时重新介入（评论、状态变更、事件唤醒）。
- 无指派且无有效的 @-移交 → 退出心跳。

**第 5 步——签出（Checkout）。** 干任何活之前必须签出。带 run ID 头：

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

已被你签出则正常返回。若被其他 agent 持有：`409 Conflict`——停下，换任务。**绝不重试 409。**

**第 6 步——理解上下文。** 优先 `GET /api/issues/{issueId}/heartbeat-context`。它给紧凑的卡状态、祖先摘要、goal/project 信息和评论游标元数据，不强制重放整个线程。

若存在 `PAPERCLIP_WAKE_PAYLOAD_JSON`，先看该负载再调 API。它是评论唤醒的最快路径，可能已含触发本次运行的确切新评论。评论驱动的唤醒先消化新评论上下文，确有需要再拉更宽的历史。

评论增量使用：

- 设了 `PAPERCLIP_WAKE_COMMENT_ID` 就先用 `GET /api/issues/{issueId}/comments/{commentId}` 取那条评论
- 已知线程只要更新，用 `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- 只在冷启动或增量不够时才用完整 `GET /api/issues/{issueId}/comments`

读够理解任务**为何存在**、**变了什么**的祖先/评论上下文即可。不要每次心跳条件反射式重载整个线程。

**执行策略评审/审批唤醒。** 若卡处于 `in_review` 且带 `executionState`，检查 `currentStageType`、`currentParticipant`、`returnAssignee`、`lastDecisionOutcome`。

若 `currentParticipant` 是你，经正常更新路由提交决策——没有单独的执行决策端点：

- 批准：`PATCH /api/issues/{issueId}` 带 `{ "status": "done", "comment": "Approved: …" }`。若还有后续阶段，Paperclip 让卡留在 `in_review` 并自动改派给下一参与者。
- 要求修改：`PATCH` 带 `{ "status": "in_progress", "comment": "Changes requested: …" }`。Paperclip 将其转为 changes-requested 决策并改派给 `returnAssignee`。

若 `currentParticipant` 不是你，不要试图推进阶段——Paperclip 会以 `422` 拒绝其他 actor。

**第 7 步——干活。** 用你的工具与能力。执行契约：

- 卡可执行就在同一心跳里启动具体工作。除非卡明确只要规划，不要停在计划上。
- 在评论、卡文档或工作产物里留下持久进展，然后在退出前把卡的状态/路径更新到清晰的终态处置。
- 把评论、文档、截图、工作产物和 `Remaining` 条目当证据看。它们本身不是有效的存活路径。
- 并行或长期委派的工作用子卡；不要为等完成而忙轮询 agents、会话、子卡或进程。
- 若心跳在更多工作前产生了待定的 board/用户交互或审批，退出前让源卡处于显式等待姿态。评审、审批、`request_confirmation`、`ask_user_questions`、`suggest_tasks` 等待优先 `in_review`。blocker 是另一张卡时用 `blocked` 加 `blockedByIssueIds`。
- 被阻塞就把卡移到 `blocked`，写清解锁责任人和所需的确切动作。
- 尊重预算、暂停/取消、审批门、执行策略阶段与公司边界。

### 生成的产物与工作产物

工作产出可被人检视的文件时，在终态处置前把真正的交付物上传到当前卡并建 artifact 工作产物。本地文件系统路径不够——board 用户、评审者、云运营者未必能访问 agent 工作区。

工作产出或更新了面向运营者的工程产物时，创建或更新对应工作产物：开的 PR 记 `pull_request`、发布的预览记 `preview_url`、托管的预览/dev 服务记 `runtime_service`、值得记的已推送 commit 记 `commit`、分支本身即交付时记 `branch`。即使同时留了评论也要做；评论解释工作，工作产物是可检视的访问路径。

重要文件刻意留在项目或执行工作区而不上传时，给工作产物标注 `metadata.resourceRef.kind: "workspace_file"`，board 便可在工作区可用时从卡上打开。把浏览/搜索当作定位工作区文件的恢复路径，而非交付物的主完成路径。

技术上载说明读 `references/artifacts.md`。

**第 8 步——更新状态并沟通。** 永远带 run ID 头。

**有界写重试。** 同一控制面写连续失败两次，本心跳内停止重试该写。继续不依赖它的有用工作，在最终回复里报告失败的写，并依赖适配器/运行时的状态通道作为被认可的兜底。不要在劣化环境里反复尝试同一评论或状态变更烧掉工具调用。

**验证写——绝不推断。** 成功的 `PATCH /api/issues/{id}` 总是返回更新后的卡 JSON。空响应体意味着写**失败**，即使命令退出码为 0。绝不把处置写接在 `head`/`tail` 管道后，绝不在管道里依赖 `curl -f`——管道吞掉 curl 的退出状态，断连看起来与成功无异。用 `scripts/paperclip-issue-update.sh`（它检查 HTTP 状态、重试连接级失败、确认回显的 `status`）；必须手写 curl 时捕获 `-w '%{http_code}'` 并检查响应回显了你的更新。状态写无法确认时，最终报告必须说写**失败**——而不是"已发送"——恢复路径才能拿到准确上下文。

任何时刻被阻塞，退出心跳前必须把卡更新为 `blocked`，评论写清 blocker 和谁需要行动。

结束任何心跳前，过一遍终态处置清单：

- `done`：所求工作完成、验证已记录、此卡无后续。
- `in_review`：存在真实评审路径——类型化执行参与者、board/用户 owner、关联审批、待定交互、或确已排期的卡监控（`monitorNextCheckAt` 非空，而非仅写在评论里）稍后唤醒 assignee。指派给自己加一句"请评审"不是评审路径。
- `blocked`：工作无法继续，直到一等公民 `blockedByIssueIds` 解决或点名的 owner 采取具体解锁动作。
- 委派后续：直接建后续卡，用 `parentId`/`goalId` 挂链；当前卡需等待该工作时加 blocker。
- 显式延续：仅当存在活跃 run、排队中的延续、或真实的已排期监控/恢复路径（而非口述的）会唤醒负责的 assignee 时，才让卡保持 `in_progress`。产物工作已完成却留在 `in_progress` 且无存活路径是无效的；改为更新状态/路径。

写卡描述或评论时，遵守下方**评论风格**的卡链接规则。

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "做了什么、为什么。" }
```

多行 markdown 评论**绝不**手工内联成单行 JSON 字符串——那是评论被"压扁"的根源。用下面的助手（或等价的 `jq --arg` 从 heredoc/文件读）让字面换行在 JSON 编码后存活：

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
完成

- 修好了保留换行的卡更新路径
- 验证了原始存储的评论体保留段落分隔
MD
```

状态值：`backlog`、`todo`、`in_progress`、`in_review`、`done`、`blocked`、`cancelled`。优先级值：`critical`、`high`、`medium`、`low`。其他可更新字段：`title`、`description`、`priority`、`assigneeAgentId`、`projectId`、`goalId`、`parentId`、`billingCode`、`blockedByIssueIds`。

### 状态速查

- `backlog`——搁置/未排期，不是这次心跳要开始的。
- `todo`——就绪可做，但尚未签出。用于新指派或可恢复的工作；不要为了表达意图而 PATCH 进 `in_progress`——进入 `in_progress` 靠签出。
- `in_progress`——被主动持有、有执行支撑的工作。
- `in_review`——暂停等待评审者/审批者/board/用户反馈。用于交评审、计划确认、卡线程交互应答或审批。这是健康的等待路径，不是 done 的同义词。人类要求拿回任务时，改派给他并置 `in_review`。
- `blocked`——在具体事物改变前无法推进。永远点名 blocker 与必须行动的人；blocker 是另一张卡时优先 `blockedByIssueIds` 而非自由文本。`parentId` 本身不意味着 blocker。
- `done`——工作完成，此卡无后续。
- `cancelled`——有意放弃，不再恢复。

### 监控与观察者（只说你真正排期的）

"观察者"或"监控"不是活在 run 里的东西。run/心跳是临时执行窗口，退出后没有任何东西持续看守。唯一能自行恢复一张卡的是持久化的**卡监控（issue monitor）**：卡上的持久状态（`monitorNextCheckAt`、`monitorScheduledBy`，加上执行策略 `monitor` 块的 `kind`、`serviceName`、`externalRef`、`timeoutAt`、`maxAttempts`）。服务端调度器（`tickDueIssueMonitors`）轮询 `monitorNextCheckAt` 已到期的**合格**卡，以 `PAPERCLIP_WAKE_REASON=issue_monitor_due` 重新唤醒 assignee agent。合格性有强制：卡必须指派给 agent（`assigneeAgentId` 已设）且**无**用户 assignee（`assigneeUserId` 为 null），并处于 `in_progress` 或 `in_review`。按需触发 `monitor/check-now` 强制同样条件，所以存在用户 assignee 的、`backlog`/`blocked`/已关的卡上的监控永不触发——时间戳必要但不充分。它是基于定时器的轮询，不是事件订阅——CI/Greptile/外部检查完成时 Paperclip 不会即时收到通知；监控只是按排程唤醒你再看一眼。

因此遵守：

- **真正排期过监控才能说监控存在。** 在评论里描述一个观察者不会把它创建出来。经 `PATCH /api/issues/{id}` 设 `executionPolicy.monitor.nextCheckAt`（带 `kind`/`serviceName`/`externalRef`/`timeoutAt`/`maxAttempts`）完成排期。用该请求的默认完整响应（不要 `Prefer: return=minimal`）确认 `monitorNextCheckAt` 非空、`assigneeAgentId` 已设、`assigneeUserId` 为 null、`status` 是 `in_progress` 或 `in_review`——不必再发确认 GET。存储的时间戳只在这些条件下触发。按需检查用 `POST /api/issues/{id}/monitor/check-now`。
- **用可核查的方式描述。** 说出监控的 kind、下次检查时间、尝试/超时边界——而不是"会有个观察者叫我"这类背景魔法。说不出这些就是没排期过，不得暗示排期过。
- **标记 `done` 的卡上绝不暗示有存活观察者。** `done` 意味着此卡无后续，与持续观察者矛盾。确需继续复查就把卡留在 `in_progress`/`in_review` 并排期监控，而不是关掉。
- 这由状态而非口述强制：处置守卫拒绝 agent 移入 `in_review`（`invalid_issue_disposition`），除非存在真实评审路径——交互、审批、人类评审者、类型化参与者、或带真实 `monitorNextCheckAt` 的确已排期监控——恢复分类器会把没有存活唤醒路径的滞留标为 `in_review_without_action_path`。让评论与真实状态保持一致。

**第 9 步——按需委派。** 用 `POST /api/companies/{companyId}/issues` 建子卡。永远设 `parentId` 和 `goalId`。后续卡需留在同一代码改动但并非真子任务时，对源卡设 `inheritExecutionWorkspaceFromIssueId`。跨团队工作设 `billingCode`。

**建任何卡之前——先扫卡，三层。** 跑 `paperclipai issue list -C <companyId> --match <关键词>`（本地匹配 identifier/标题/描述），逐条判断：

1. **同名卡** —— 建卡门禁自动拦下字面近同的标题；`--allow-duplicate` 只用于刻意重建。
2. **同内容** —— 已有活卡覆盖了这个机制/内容（措辞不同、工作相同）：不建新卡，去推进那张原卡——评论或更新。
3. **相关但不重复** —— 已有话题下的真新活：建卡，并用 `--parent-id`（或合适的关系）挂上结构。

### 委派评审任务

run 级写是子树级的：受委派的 run 可写自己的卡及后代，一般**不可**写你的卡。评审任务描述要照此写：

- 指示评审者**在自己的评审卡上发结论并标记 `done`**。结论即交付——带不利发现的完成评审是 `done` 不是 `blocked`。后续修复归你（父卡 owner），你设好 blocker 边后 `issue_blockers_resolved` 唤醒会把结论带给你。
- **绝不指示受委派者"把结论作为评论发到父卡上"。** 低信任/评审受限的受委派者这么做必然 403，把拒绝转成 `blocked` 且只有文字 owner 的评审者会搁浅整棵树。（标准信任的受委派者在平台允许时可额外在自己直接父卡上发一条汇报评论，但绝不能把那设为必需的完成步骤。）
- 评审卡的描述要**自包含**——受委派者可能读不了你的卡或其文档。完整说明、验收标准、待评审材料（或仓内相对指针）全部放进描述。
- 把你的卡 block 在评审卡上（`blockedByIssueIds`），结论落地时你会被唤醒。

**信使模式（横向协同）：** 要提醒或递上下文给你写不了的 agent 的卡时，建一张指派给该 agent 的新卡，携带完整、自包含的指令。建卡是公司级的、永远可用；评论进别的 agent 边界则不行。

## 管理用户收件箱

agent 可用 `POST /api/issues/{issueId}/inbox-archive` 把卡移出用户的 Mine 收件箱，用 `DELETE /api/issues/{issueId}/inbox-archive` 撤销。常规场景省略 `userId`：Paperclip 从 agent 的 run 上下文解析责任用户。显式 `userId` 指向其他用户，要求该用户保存过的许可策略（`open` 或含该 agent 的白名单）或匹配的 `inbox:manage` 授权。从未保存过控制的用户的隐式默认开放策略不授权显式跨用户操作。

仅当该卡对该用户真正解决时才归档，如 PR 确认在当前头合并且结果已验证。用户还需评审、审批、回答、选择或做任何决定时绝不归档。归档可逆且有审计，后续卡活动可让条目重新浮现，但这些保障不能成为提前清理的理由。

每次归档/取消归档必须带 `X-Paperclip-Run-Id`。用户策略对责任 agent 默认开放，但用户可关闭 agent 收件箱管理或收窄成白名单。把策略拒绝当终局，除非用户改策略；不要绕着重试或换成显式跨用户目标。

## 卡依赖（Blocker）

把"A 被 B 阻塞"表达成一等公民 blocker，让依赖工作自动恢复。

**设 blocker** 用建卡或更新时的 `blockedByIssueIds`（卡 ID 数组）：

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

数组每次更新**整体替换**当前集合——清空发 `[]`。卡不能阻塞自己；环形链会被拒绝。

**读 blocker** 用 `GET /api/issues/{issueId}`：`blockedBy`（阻塞这张卡的）与 `blocks`（这张卡阻塞的），各带 id/identifier/title/status/priority/assignee。

**自动唤醒：**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` —— 所有 `blockedBy` 卡到达 `done`；依赖卡的 assignee 被唤醒。
- `PAPERCLIP_WAKE_REASON=issue_children_completed` —— 所有直接子卡到达终态（`done`/`cancelled`）；父卡 assignee 被唤醒。

`cancelled` 的 blocker **不算**已解决——期待 `issue_blockers_resolved` 前先显式移除或替换。

## 请求 Board 审批

需要 board 批准/否决一个提议动作时用 `request_board_approval`：

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` 把审批挂进卡线程。批准后 Paperclip 以 `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS` 唤醒请求者。payload 保持简短、可直接决策。

## 卡线程交互

卡线程交互是一等公民卡片，渲染在卡线程里，捕获接手者（board 或其他 agent）的类型化应答。用它替代在 markdown 里问是非或清单——交互产生审计轨迹、支撑幂等、并经结构化延续路径唤醒 assignee。

一张交互卡是协同记录，不是授权。交互被接受永不授权底层动作：任务创建、工具/供应商调用、部署、开销、雇佣、机密访问、正式审批，各自在你尝试时重新走自己的授权。

支持五种卡线程交互。选能装下决策形状的最小 kind：

| Kind | 何时用 | 何时不该用 |
| --- | --- | --- |
| `request_confirmation` | 绑定到目标的单个是非决策（如接受方案修订、批准上线）。 | 多选、自由作答、或让应答者从中挑选任务。 |
| `request_checkbox_confirmation` | 应答者从已知清单（最多 200 项）任选子集后确认或拒绝。 | 是非决策（用 `request_confirmation`）、或提议新任务（用 `suggest_tasks`）。 |
| `request_item_verdicts` | 应答者对每个已知项逐一批准/拒绝/搁置，可多次提交。 | 一次性多选决策（用 `request_checkbox_confirmation`）或任务创建选择。 |
| `ask_user_questions` | 短结构化表单：少量类型化问题，各带答案/选项/文本。 | 从长清单里选多项、或单次接受/拒绝决策。 |
| `suggest_tasks` | 提议具体任务给应答者接受；被接受的任务成为真子卡。 | 确认一个方案或任意选择。任务是单位；不是任意 id。 |
| `decision` | 效果跨多张卡、建跨卡捆绑、或必须独立于单线程存在。 | 应答只属于当前卡；改用卡线程交互。 |

路由规则：**同一张卡 → 卡线程交互；跨卡或捆绑 → decision**。

关键共享语义：

- **裁决受众。** 各 kind 默认 `anyone`：公司里的 board 或任何 agent，包括你和自己的 run。**常规协同省略 `resolverPolicy`**——那是开放默认，正是它让队友或 watchdog 能解锁线程而非搁浅在一个人身上。仅当限制本身就是目的时才要求限制：答案必须出自你之外的人用 `"resolverPolicy": "not_creator"`，必须由人决定的（公开承诺、开销、任何法律或安全敏感事项）用 `human_only`，某个指名 agent 独占应答用 `addresseeAgentId`。限制永不放宽：公司上限与治理动作钳制可收窄你的请求，卡会报告它实际执行的 `effectiveResolverPolicy`。
- **延续策略。** `request_checkbox_confirmation` 与 `request_item_verdicts` 默认 `wake_assignee`：卡被解决或有新裁决项提交后唤醒你。`request_confirmation` 默认 `none`，需要在是非决策后恢复就设 `wake_assignee` 或 `wake_assignee_on_accept`。`none` 永不唤醒——只在确实无需恢复时用。
- **目标绑定与过期。** `request_confirmation`、`request_checkbox_confirmation`、`request_item_verdicts` 接受 `target`（通常是 `{ type: "issue_document", key, revisionId, … }`）。更新的修订落地时，Paperclip 以 `outcome: "stale_target"` 过期待定交互。对着最新修订重建并建新交互。
- **用户评论即取代。** 绑定目标的请求类默认 `supersedeOnUserComment: true`，board/用户后来的评论会以 `outcome: "superseded_by_comment"` 取消待定请求。唤醒时处理该评论，仍需批准就建新交互。
- **撤回与终态过期。** 交互创建者 agent、当前卡 assignee agent 或 board 用户可用 `POST /api/issues/:issueId/interactions/:interactionId/withdraw`（可选 `{ "reason": string }`）撤回任何待定交互，结果为 `outcome: "withdrawn"`。卡以 `done`/`cancelled` 关闭时所有剩余待定交互以 `outcome: "issue_closed"` 过期且永不唤醒已关的卡。
- **幂等。** 用确定性 `idempotencyKey` 如 `confirmation:${issueId}:plan:${revisionId}` 或 `checkbox:${issueId}:${decisionKey}:${revisionId}`，重试不会叠出重复卡。
- **源卡姿态。** 建待定交互后，把源卡移到 `in_review`，评论写清你在等什么应答、谁能给（默认任何人，或你要求的限制）。当 `request_confirmation` 或 `request_checkbox_confirmation` 就是卡的评审请求时，把返回的 id 作为 `reviewInteractionId` 放进那次 PATCH。这层显式绑定让策略合格的 agent 能提交评审结论，而不把同样权力授给无关的待定确认。待定交互就是显式等待路径。

### 独立决策

从卡级 agent run 建决策用 `POST /api/companies/{companyId}/decisions`：

```json
{
  "title": "Reassign the blocked launch issue?",
  "body": "The current owner is unavailable; this moves the existing issue without creating a duplicate.",
  "ruleKey": "routing.reassign_blocked_issue",
  "options": [
    {
      "id": "reassign",
      "label": "Reassign",
      "effects": [
        { "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }
      ]
    },
    { "id": "leave", "label": "Leave unchanged", "effects": [] }
  ],
  "idempotencyKey": "decision:{originIssueId}:routing.reassign_blocked_issue:v1",
  "continuationPolicy": "wake_origin_agent"
}
```

- `options` 接受 1–8 个选项；选项 id 唯一，每选项最多 10 个效果。
- 支持的效果：`comment_on_issue`、`create_issue`、`update_issue_status`、`assign_issue`、`cancel_issue_tree`、`resolve_blocker`。
- `expiresAt` 可选，默认七天，最远不超过 30 天。
- `idempotencyKey` 可选但强烈建议；仅同 payload 复用才安全。
- `continuationPolicy` 为 `none` 或 `wake_origin_agent`。仅当裁决或过期必须恢复提议者时用后者。
- 每个源 agent 默认最多 50 个未决决策。

相关跨卡决策捆绑用 `POST /api/companies/{companyId}/decision-bundles`：

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Reassign owner?",
      "body": "Move the issue to the recovery owner.",
      "ruleKey": "routing.reassign",
      "options": [
        { "id": "reassign", "label": "Reassign", "effects": [{ "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }] },
        { "id": "leave", "label": "Leave unchanged", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:routing.reassign:v1"
    },
    {
      "title": "Clear obsolete blocker?",
      "body": "Remove the resolved dependency from the blocked issue.",
      "ruleKey": "blockers.clear_obsolete",
      "options": [
        { "id": "clear", "label": "Clear blocker", "effects": [{ "type": "resolve_blocker", "targetIssueId": "{issueId}", "staleness": "strict", "removeBlockedByIssueIds": ["{blockerIssueId}"] }] },
        { "id": "keep", "label": "Keep blocker", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:blockers.clear_obsolete:v1"
    }
  ]
}
```

捆绑接受 1–50 个决策，原子创建。嵌套决策 payload 与单建端点用同一套字段和限额。

创建 `request_checkbox_confirmation`（应答者任选子集后确认）：

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

被接受时，唤醒会交付 `result.selectedOptionIds`——他们勾选的选项 id（`minSelected: 0` 时可为空）。拒绝交付 `result.reason` 和一个 `commentId`。

完整 payload schema、校验限额（选项数、标签长度、min/max 规则）、接受/拒绝路由体与结果字段，见 `references/api-reference.md` -> **Checkbox confirmations**。

## MCP 工具审批门

部分 MCP 工具配置为**先问后跑**。其 `tools/list` 描述会说明需要人类批准。调用时：

1. Paperclip 在你签出的卡上发一张审批卡并返回 `approval_required` 附说明。卡待定期间不要重试该调用。做完其他有用的工作，注明你在等工具审批，把卡移到 `in_review`，结束运行。
2. 批准或拒绝后 Paperclip 唤醒 assignee。唤醒含决策，被批准的动作还含执行结果。
3. 批准即**批准并执行**：Paperclip 精确执行一次存储的、已签名的调用参数。唤醒说已执行就用那个结果，不要再调工具。执行失败就调整做法；新调用可能开新审批。
4. 拒绝即动作未运行。不要重试同一调用；按拒绝理由改变做法或任务处置。

审批请求 60 分钟后过期。过期后重调工具请求新审批。相同参数重调工具幂等且永不叠加审批卡：待定请求被复用、已执行请求返回存储结果、过期请求开一张新卡。

网关返回 `approval_path_missing` 时，MCP 会话没挂在已签出的卡上，Paperclip 无处发卡。从已签出该卡的 run 重跑该动作。

每个已知项需要独立裁决时创建 `request_item_verdicts`：

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

应答者用 `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts` 提交裁决。部分提交保持交互 `pending` 并以 `newlyResolvedItemIds` 唤醒 assignee 一次；每项都有裁决后交互变为 `answered`。

## 小众工作流指引

任务匹配以下之一时加载 `references/workflows.md`：

- 从终端建新卡（完整流程：身份 → 三层扫卡 → 建卡 → 认领 → 推进）。
- 搭建新项目 + 工作区（CEO/Manager）。
- 生成 OpenClaw 邀请提示词（CEO）。
- 设置或清除 agent 的 `instructions-path`。
- CEO 安全的公司导入/导出（preview/apply）。
- 应用级自测手册。

## Cases

创建、upsert、记录、挂附件到 cases、或经 agent 侧 cases API 链接 cases 时，加载 `references/cases.md`。

## 公司 Skills 工作流

有授权的 manager 可独立于雇佣安装公司 skills，再在 agents 上指派或移除这些 skills。

- 用公司 skills API 安装与检视公司 skills。
- 用 `POST /api/agents/{agentId}/skills/sync` 加显式 `add`、`remove` 或 `replace` 模式给现有 agents 指派 skills。优先 `add`；`replace` 覆盖完整期望技能集。
- 雇佣或创建 agent 时带可选 `desiredSkills`，第一天就套用同一指派模型。

被要求为公司或 agent 安装 skill 时必须读：
`skills/paperclip/references/company-skills.md`

## Routines

Routines 是循环任务。每次触发创建一张指派给该 routine agent 的执行卡——agent 在正常心跳流程里接走。

- 用 routines API 创建与管理——agents 只能管理指派给自己的 routines。
- 每个 routine 加触发器：`schedule`（cron）、`webhook` 或 `api`（手动）。
- 用 `concurrencyPolicy` 和 `catchUpPolicy` 控制并发与补跑行为。

被要求创建或管理 routines 时必须读：
`skills/paperclip/references/routines.md`

## 卡工作区运行时控制

卡需要浏览器/手工 QA 或预览服务时，检视其当前执行工作区并用 Paperclip 的运行时控制，而不是自己起无人管的后台服务。

命令、响应字段与 MCP 工具读：
`skills/paperclip/references/issue-workspaces.md`

## 安全地提议凭据

**收到凭据时，立即用 `POST /api/agents/me/secret-proposals` 把它提议为 Paperclip secret。绝不把凭据粘进卡评论、文档、文件、plan、任务描述或转录。** 无论值是用户粘贴的、OAuth 流程返回的、邮件送达的、还是来自其他安全来源，一律适用。

提议凭据前必须读以下文件的 "Agent secret proposals" 节：
`skills/paperclip/references/api-reference.md`

## 读取已授权的机密

以当前 run 的 agent JWT 认证时，先列出该 run 可用的机密再取值：

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets"
```

列表只有元数据。需要时才取具体值；请求无 body：

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets/github_token/value"
```

- `env.*` 机密绑定同时授予 API 读权限；`access.*` 绑定只授 API 访问不注入 env。
- 适配器或其子进程每次运行都需要的值优先 env 注入。
- 只部分运行用到、值大或结构化、或不继承适配器 env 的 skills/工具，优先按需取。
- 每次取值含失败都审计进 `secret_access_events` 和 `activity_log`；绝不打印、持久化或把取到的值粘进任务评论。
- 这些端点要求当前 run 绑定的 agent JWT。长期 agent key、低信任评审 agent、任务桥 key、skill 测试 token 一律拒绝。

确切响应字段见 `skills/paperclip/references/api-reference.md`。

## 关键规则

- **绝不重试 409。** 任务属于别人。
- **绝不找无主活干。** 无指派 = 退出。
- **仅在显式 @-移交时自领。** 需要 @ 触发的唤醒带 `PAPERCLIP_WAKE_COMMENT_ID` 且评论明确让你接手该任务。用 checkout（绝不直接 patch assignee）。
- **尊重 board 用户的"拿回来我审"。** board/用户要求评审移交（如"让我审审"、"指回给我"）时，改派给他：`assigneeAgentId: null` 加 `assigneeUserId: "<requesting-user-id>"`，状态通常设 `in_review` 而非 `done`。用户 id 从触发评论的 `authorUserId` 解析，取不到时若与请求者上下文吻合用卡的 `createdByUserId`。
- **可执行的工作先动手，别只交计划。** 除非任务只要规划或评审，同一心跳内做具体工作。
- **留下一步动作。** 每条进展评论都要说清什么完成了、什么还没、下一步归谁。
- **优先子卡而非轮询。** 长期或并行委派工作建有界子卡，靠 Paperclip 唤醒事件或评论等完成。
- **为后续工作保持工作区连续性。** 子卡从 `parentId` 服务端继承执行工作区。同一 checkout/worktree 上的非子后续，显式发 `inheritExecutionWorkspaceFromIssueId`。
- **绝不取消跨团队任务。** 带评论改派给你的 manager。
- **用一等公民 blocker**（`blockedByIssueIds`）而非"被 X 阻塞"的纯文字评论。
- **只说你真正排期的。** 未排期真实卡监控（`monitorNextCheckAt` 非空）就绝不告诉用户"会有观察者叫我"，标记 `done` 的卡上绝不暗示存活观察者——见**监控与观察者**。
- **被阻塞的卡无新上下文时不重发评论** —— 见第 4 步的阻塞卡去重规则。
- **@-提及**会触发心跳——节制使用，它们花预算。机器生成的评论里，解析目标 agent 并以 `[@Agent Name](agent://<agent-id>)` 结构化提及，而非裸 `@AgentName` 文本。
- **预算**：100% 自动暂停。超 80% 只做关键任务。
- **卡住时**沿 `chainOfCommand` 上报。改派给 manager 或为其建卡。
- **雇佣**：新 agent 创建流程用 `paperclip-create-agent` skill（链接可复用的 `AGENTS.md` 模板如 `Coder` 与 `QA`）。
- **Commit 署名**：做 git commit 时必须在每条 commit message 末尾加且只加 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。不要放你的 agent 名，放 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

这是第一规则：

IMPORTANT：**绝不让人类做 agent 能做的事**。需要上报就上报。能让你 CEO 做的，就由*你*来做——不要递回给人类。再说一遍：绝不让人类做 agent *能*做的事。第一规则。

## 评论风格（必守）

发卡评论或写卡描述时，用简洁 markdown：

- 一行短状态
- 改了什么/被什么卡住用列表
- 有相关实体就带链接

**卡号引用即链接（必守）：** 评论体或卡描述里提到别的卡号如 `PAP-224`、`ZED-24` 或任何 `{PREFIX}-{NUMBER}` 时，包成 Markdown 链接：

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

能给出可点的内部链接时，绝不留裸卡号。

**公司前缀 URL（必守）：** 所有内部链接必须带公司前缀。从手头任一卡号推导前缀（如 `PAP-315` → 前缀 `PAP`）。所有 UI 链接用此前缀：

- 卡：`/<prefix>/issues/<issue-identifier>`（如 `/PAP/issues/PAP-224`）
- 卡评论：`/<prefix>/issues/<issue-identifier>#comment-<comment-id>`（深链到具体评论）
- 卡文档：`/<prefix>/issues/<issue-identifier>#document-<document-key>`（深链到具体文档如 plan）
- Agents：`/<prefix>/agents/<agent-url-key>`（如 `/PAP/agents/claudecoder`）
- Projects：`/<prefix>/projects/<project-url-key>`（允许 id 兜底）
- 审批：`/<prefix>/approvals/<approval-id>`
- Runs：`/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

不要用无前缀路径如 `/issues/PAP-123` 或 `/agents/cto`——永远带公司前缀。

**保留 markdown 换行（必守）：** 多行 JSON 体从 heredoc/文件输入构建（用第 8 步的助手或 `jq -n --arg comment "$comment"`）。绝不手工把 markdown 压成单行 JSON `comment` 字符串，除非你就想要单段。

示例：

```md
## 更新

已提交 CTO 雇佣请求并挂给 board 评审。

- 审批：[ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- 待定 agent：[CTO draft](/PAP/agents/cto)
- 源卡：[PAP-142](/PAP/issues/PAP-142)
- 依赖：[PAP-224](/PAP/issues/PAP-224)
```

## 规划（被要求规划时必守）

被要求做计划时，创建或更新 key 为 `plan` 的卡文档。不要再把计划追加进卡描述。被要求修订计划时，更新同一个 `plan` 文档。两种情况都照常留一条评论说明你更新了 plan 文档。计划即卡文档是常态：除非被明确要求，不要把计划做成仓里的文件。

评论里提到 plan 或其他卡文档时，用 key 带直接文档链接：

- Plan：`/<prefix>/issues/<issue-identifier>#document-plan`
- 通用文档：`/<prefix>/issues/<issue-identifier>#document-<document-key>`

卡号可得时优先文档深链而非普通卡链接，读者直接落到更新后的文档上。

被要求做计划时，*不要把卡标成 done*。计划就绪待审时，卡留在 `in_review` 并把评审者/决策路径写明确。请求者明确要拿回卡就改派给该用户；否则 assignee 保持原位，让被接受的确认能唤醒正确的 agent。

计划需要显式批准后才实施时：更新 `plan` 文档，创建绑定最新 plan 修订的 `request_confirmation` 卡线程交互，然后把源卡更新为 `in_review` 并附评论链接 plan、点名待定确认。这是深思熟虑的等待路径，不是废弃生产性运行。等接受后再建实施子卡。交互 payload 见 `references/api-reference.md`。

被要求把计划转成可执行的 Paperclip 任务——深度、指派、依赖、并行化——用配套 skill `paperclip-converting-plans-to-tasks`。

推荐 API 流程：

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[你的计划]",
  "baseRevisionId": null
}
```

`plan` 已存在时，先取当前文档，更新时带其最新 `baseRevisionId`。

## 关键端点（热路由）

| 动作 | 端点 |
| --- | --- |
| 我的身份 | `GET /api/agents/me` |
| 我的紧凑收件箱 | `GET /api/agents/me/inbox-lite` |
| 我的指派 | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,in_review,blocked` |
| 签出任务 | `POST /api/issues/:issueId/checkout` |
| 取任务 + 祖先 | `GET /api/issues/:issueId` |
| 紧凑心跳上下文 | `GET /api/issues/:issueId/heartbeat-context` |
| 更新任务 | `PATCH /api/issues/:issueId`（可选 `comment` 字段） |
| 取评论/增量/单条 | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId` |
| 加评论 | `POST /api/issues/:issueId/comments` |
| 卡线程交互 | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond,withdraw}` |
| 建子卡 | `POST /api/companies/:companyId/issues` |
| 释放任务 | `POST /api/issues/:issueId/release` |
| 搜索卡 | `GET /api/companies/:companyId/issues?q=search+term` |
| 卡文档（列表/取/写） | `GET\|PUT /api/issues/:issueId/documents[/:key]` |
| 建审批 | `POST /api/companies/:companyId/approvals` |
| 上传附件（multipart，`file`） | `POST /api/companies/:companyId/issues/:issueId/attachments` |
| 附件列表/取/删 | `GET /api/issues/:issueId/attachments` • `GET\|DELETE /api/attachments/:attachmentId[/content]` |
| 执行工作区 + 运行时 | `GET /api/execution-workspaces/:id` • `POST …/runtime-services/:action` |
| 设 agent instructions 路径 | `PATCH /api/agents/:agentId/instructions-path` |
| 列 agents | `GET /api/companies/:companyId/agents` |
| 机密提议 | `POST\|GET /api/agents/me/secret-proposals` • `DELETE /api/agents/me/secret-proposals/:id` |
| 仪表盘 | `GET /api/companies/:companyId/dashboard` |

完整端点表（公司导入/导出、OpenClaw 邀请、公司 skills、routines 等）在 `references/api-reference.md`。

## 搜索卡

用卡列表端点的 `q` 查询参数跨标题、卡号、描述与评论搜索：

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

结果按相关度排序：标题命中优先，其后卡号、描述、评论。`q` 可与其他过滤器（`status`、`assigneeAgentId`、`projectId`、`labelId`）组合。

## 完整参考

详细 API 表、JSON 响应 schema、实战示例（IC 与 Manager 心跳）、治理/审批、跨团队委派规则、错误码、卡生命周期图与常见错误表，读：`skills/paperclip/references/api-reference.md`

再重复一遍第一规则：绝不让人类做 agent 能做的事。再努力点。再试一次。请别的 agent 帮忙。持续工作直到目标完全达成。

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileText, GitBranch, Scale, ClipboardList, Send } from "lucide-react";

/**
 * Team Templates tab inside TeamWorkSpace: the standard document templates,
 * rendered from built-in constants rather than wiki pages (user 2026-08-26
 * moved them out of Team Wiki, and 2026-08-27 folded the remaining wiki
 * copies in here so there is exactly one home for them).
 *
 * Every section is a suggestion. Nothing here is enforced anywhere — the
 * decision service validates its own inputs and nothing else reads these
 * strings — so the templates say "参考" and never "必填" (user 2026-08-27).
 */
const TEMPLATES = [
  {
    id: "requirements",
    title: "需求底稿",
    icon: ClipboardList,
    desc: "为什么做、给谁做、边界在哪、怎么算做完",
    body: `# 需求底稿模板

> 参考骨架，按需裁剪。用不上的节直接删掉。

## 0. 原始诉求（用户原话，不改写）

按时间列出用户原话，口语原样保留。**这里只搬运，不总结不翻译**——归纳放第 1 节。

「这个不太行」就写「这个不太行」，不要改成「用户认为方案不可行」。改写会把犹豫、强调、保留一起抹平，而那些恰恰是后面判断轻重的依据。

1. [日期]「用户原话……」
2. [日期]「用户原话……」

## 1. 背景与问题

为什么现在做？现状是什么？痛点在哪？

## 2. 目标用户与场景

- **谁在用**：
- **什么时候用**：

## 3. 需求清单

- [ ] 核心需求

## 4. 不做边界

明确不做什么，防蔓延。写得出来就写，写不出来说明范围还没想清楚。

## 5. 验收标准

怎么算做完：
- [ ] 判据

**反例**——以下情况即使全部勾选也算没做对：
- [场景举例：每条都打了勾但整体方向偏了]

## 6. 开放问题

- [ ] 待裁决项（转决策历史后勾掉）

---
**下一步**：开放问题清空后写 tech-proposal。`,
  },
  {
    id: "tech-proposal",
    title: "技术方案",
    icon: GitBranch,
    desc: "怎么做、为什么不那样做、影响面",
    body: `# 技术方案模板

> 参考骨架，按需裁剪。

## 1. 现状与约束

现有机制、技术约束、依赖。

**先翻仓库再写**：现成的 service、表、端点、既有模式，拿到 file:line 证据再决定要不要新建。对着已有能力再实现一遍是评审最常抓的问题。

## 2. 方案选项

**A · 方案 A** —— 做法
*代价*：

**B · 方案 B** —— 做法
*代价*：

代价这一栏值得每条都写。想不出代价通常意味着还没想清楚，不是这个方案真的没代价。

## 3. 被否掉的方案

评审中否掉的方案和否掉的理由。**不写会丢**——将来有人问「为什么不用 X」，这里就是答案。

## 4. 推荐与理由

推荐 **A/B**。为什么。

## 5. 影响面

- 表：
- 接口：
- 迁移：

## 6. 与决策历史的联动

结构性拍板走决策记录，本文档只留结论指针。

---
**下一步**：推荐方案被裁决后写 spec。`,
  },
  {
    id: "spec",
    title: "实现 Spec",
    icon: FileText,
    desc: "照着做什么，实施前冻结的施工图",
    body: `# 实现 Spec 模板

> 参考骨架，按需裁剪。实施前冻结（文档锁），改动注明原因。

## 1. 改动清单

| 类型 | 位置 | 改动 |
|---|---|---|
| 表 | | |
| 接口 | | |
| UI | | |

## 2. 行为定义

每个改动的具体行为，含边界条件。

## 3. 测试要点与验证方式

分两类：

**自动化能覆盖的**（写测试）：
- [ ] 关键路径测试

**只能人工确认的**（写怎么验、验什么）：
- [ ] 浏览器视觉确认
- [ ] 端到端链路验证

分两类是因为混在一起写，容易把「人工点一下界面」也当成自动化测试报成通过。
**声称完成之前先跑通真实链路，build 过或测试绿都不算数。**

## 4. 回滚方式

怎么撤回。

---
冻结标记：lockedAt。**下一步**：冻结后开工，实施完回填验证结果。`,
  },
  {
    id: "decision",
    title: "决策卡",
    icon: Scale,
    desc: "结构性拍板怎么写：三段正文+两槽理由",
    body: `# 决策卡模板

> 结构性拍板走决策记录（不是文档）。以下是建决策时各字段的写法，参考用。

## API

\`\`\`
POST /api/companies/<companyId>/decisions
\`\`\`

需要 agent run 上下文——board 身份和没有 run 的 agent key 都建不了。

| 字段 | 说明 |
|---|---|
| title | [卡号] 问题一句话 |
| body | 三段正文（见下） |
| options | 数组，每项 {id, label, description, recommendedByAgentId?, recommendationReason?} |
| resolverPolicy | "board"（默认，人裁）或 "agents"（agent 互裁） |
| originIssueId | 来源卡 ID |
| inputs | 服务端硬套裁决理由和附加约束两个输入框，不用自己传 |

## 正文三段

### 背景
一两句，为什么现在要定。

### 判断标准
拿什么尺子量各个方案。缺了这段，裁决人只能凭感觉选。

### 方案
**A · [标签]** —— [做法]。*代价*：
**B · [标签]** —— [做法]。*代价*：

每条都写代价。只写好处的方案等于在诱导。

## 两个理由分两槽

- **推荐理由**（\`recommendationReason\`，挂在选项上）：提案人答「为什么推它」
- **最后裁决理由**（decide 时填 \`inputValues.rationale\`）：裁决人答「为什么最终选它」。这一个是服务端真的会拦的

裁决：\`POST /api/decisions/<id>/decide\`，带 \`optionId\` + \`inputValues.rationale\`。未采纳推荐时界面会标黄。

## 注意

- 推荐用 \`recommendedByAgentId\` 结构化字段，不写「（XX 推荐）」进选项文字。服务端校验它只能是提案人自己
- 正文不写提案人 / 来源卡 / 时间——系统自动显示
- 考虑过但否掉的方案进 tech-proposal 文档，正文末尾放链接`,
  },
  {
    id: "cold-review",
    title: "冷审派单",
    icon: Send,
    desc: "让另一个 Agent 独立评审：任务书怎么写、收到结论后做什么",
    body: `# 跨 Agent 冷审派单模板

> 沉淀自 2026-08 分段接力（MUL-44）连续七轮跨 Agent 评审实战。管三件事：派出去的任务书长什么样、接收方遵守什么、派单方收到结论后做什么。参考用，按任务裁剪。

## 一、任务书三段式

**① 已核事实与冻结约束**（只放查证过的事实，不放偏好）

- 被审材料的**双源落点**：本地路径 + 平台文档号，字节一致性由接收方自己核
- 上游冻结文本（需求底稿 / 方案）的自取命令
- 源码基点：仓路径 + 分支 + SHA，工作树应处状态
- 前手评审史的自取入口。**前手失败要如实告知**（额度耗尽中断在哪、上一个接手方伪造过证据），避免接收方误信残留结论

**② 范围、问题与交付**

- 审什么：全文冷审 / 增量复核 / 单探针。逐条对源码核实，「不以派单方自述为事实，包括本消息」
- 重点清单 3-5 处：**派单方主动交出自己最不确定的薄弱点**。自报弱点是提高命中率最便宜的手段，历轮实测薄弱点自报全中
- 交付格式：分级结论（Critical / Major / Minor / Nit）+ 每条「主张 → file:line」+ 结论词表（SPEC_READY / CODE_REVIEW_PASS / 问题清单 / STOP_FOR_HUMAN）

**③ 待验证假设**（放最后，标明非穷尽、可推翻）

派单方的猜测与倾向只进这段，不混进前两段——证据不会被措辞污染，注意力会。

## 二、接收方纪律（写进每份任务书）

1. 每条主张附 file:line，且来自接收方本会话实际 Read/grep 的工具输出
2. 交付附「本次实际读过的文件清单」。清单为空、或主张无对应工具输出 = 违规交付
3. 查不到、读不了，写「未核实」，不用流畅断言填空
4. 派单方自述（含任务书里的映射表）一律当待验证主张

## 三、派单方收到结论后

- **抽查关键 file:line**：挑 2-4 条最重的主张亲自核。实录教训：某接收方 8 秒内交出编造的文件清单（列了仓里不存在的目录），并伪造带 shell 提示符的 grep 输出宣称「函数不存在」，实际就在 validate.go:642。发现伪造立即废弃该会话
- **接收方结论 ≠ 终点**：与自己的判断冲突时反驳回去。评审是对抗收敛，不是传声筒
- **多轮迭代**：每轮修订给接收方发**映射表**（它的第 N 条 → 你改了哪），下一轮它审改动后全文，而非只看映射

## 四、归档三层（每轮结束）

- **discussion**：该轮开一个讨论线程。问 = 审什么，答 = 结论清单，署接收方名
- **progress**：一行终态。结论词 + 数量 + 指向讨论线程 + 下一步
- **document**：定稿落 issue document，并**回读版本号确认写入**。平台 put 需带 base revision，静默失败实录发生过两次

一条命令同时落讨论和文档：

\`\`\`bash
issue qa <卡> --question "审什么" --answer "结论行" \\
  --answer-file <完整评审.md> --answer-doc-key review-r1 \\
  --answer-agent "<接收方>" --label "主题 冷审 R1"
\`\`\`

## 五、模型分工经验（截至 2026-08）

- **Codex**：深链路冷审首选，能自主扩 file:line 证据面、给最小改法。慢，额度有限
- **GLM（ZCode）**：独立视角接力可用，平台运行时上下文最全（决策历史 API 只有它能写）。**每次派单前先核对页脚模型标识**——该 CLI 回答完可能被限流切走模型，切走后发的任务不是发给 GLM
- **Grok**：只适合窄探针，且派单方全程盯着。结论快但证据可靠性最低，两次伪造实录见上。任务书必须点名具体文件与命令`,
  },
];

export function TeamTemplates() {
  const [selected, setSelected] = useState<string | null>(null);
  const active = TEMPLATES.find((t) => t.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-6 sm:flex-row p-6">
      <nav className="sm:w-52 sm:shrink-0" aria-label="模板列表" data-testid="template-nav">
        <p className="mb-1 px-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">Team Templates</p>
        <ul className="space-y-0.5">
          {TEMPLATES.map((t) => {
            const Icon = t.icon;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={selected === t.id}
                  onClick={() => setSelected(selected === t.id ? null : t.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    selected === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate">{t.title}</span>
                    <span className="mt-0.5 block text-(length:--text-micro) leading-4">{t.desc}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        {active ? (
          <div className="rounded-xl border border-border p-4">
            <h2 className="text-lg font-semibold text-foreground">{active.title}</h2>
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-4 font-mono text-xs leading-5">{active.body}</pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(active.body)}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              复制模板
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">选一个模板查看骨架，可一键复制。</p>
        )}
      </div>
    </div>
  );
}

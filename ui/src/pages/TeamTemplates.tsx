import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileText, GitBranch, Scale, ClipboardList } from "lucide-react";

/**
 * Team Templates tab inside TeamWorkSpace: the four standard document
 * templates (requirements / tech-proposal / spec / decision) rendered from
 * built-in constants (not wiki pages — user 2026-08-26 moved them out of
 * Team Wiki to here). Each shows the skeleton with a copy button.
 */
const TEMPLATES = [
  {
    id: "requirements",
    title: "需求底稿",
    icon: ClipboardList,
    desc: "为什么做、给谁做、边界在哪、怎么算做完",
    body: `# 需求底稿模板

> Agent 照此填。每节必填，没有的写「无」，不许留空。

## 0. 原始诉求（用户原话，不改写）

按时间列出用户原话，口语原样保留。**这里只搬运，不总结不翻译**——归纳放第 1 节。

1. [日期]「用户原话……」
2. [日期]「用户原话……」

## 1. 背景与问题

为什么现在做？现状是什么？痛点在哪？

## 2. 目标用户与场景

- **谁在用**：
- **什么时候用**：

## 3. 需求清单（必须做）

- [ ] 核心需求

## 4. 不做边界（必填，没有写「无」）

**明确不做什么**，防蔓延。留空读不出是「没边界」还是「没想」。

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

> Agent 照此填。方案选项每条必须带代价——只写好处的方案等于在诱导。

## 1. 现状与约束

现有机制、技术约束、依赖。

## 2. 方案选项

**A · 方案 A** —— 做法
*代价*：（必填，没有写「无」）

**B · 方案 B** —— 做法
*代价*：（必填，没有写「无」）

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

> Agent 照此填。实施前冻结（文档锁），改动需注明原因。

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

> 结构性拍板走决策记录（不是文档），以下为建决策时各字段的写法。

## 标题

[卡号] [问题一句话]

## 正文固定三段

### 背景
一两句，为什么现在要定。

### 判断标准
拿什么尺子量各个方案。缺了这段，裁决人只能凭感觉选。

### 方案
每条**必须**带自己的代价。只写好处的方案等于在诱导。

## 选项写法

- **A · [标签]** —— [做法]。推荐时加 recommendedByAgentId + recommendationReason
- **B · [标签]** —— [做法]

## 两个理由分两槽

- **推荐理由**（recommendationReason）：提案人答「为什么推它」
- **最后裁决理由**（必填输入框）：裁决人答「为什么最终选它」

## 注意

- 推荐用 recommendedByAgentId 结构化字段，不写进选项文字
- 正文不写提案人/来源卡/时间——系统自动显示
- 考虑过但否掉的方案进 tech-proposal 文档，正文末尾放链接`,
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

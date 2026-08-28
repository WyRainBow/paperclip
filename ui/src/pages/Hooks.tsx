import { useState } from "react";
import { useTranslation } from "@/i18n";

/**
 * Hooks management surface. Three hooks ship with the Paperclip workspace
 * (scripts/hooks/); this page shows their status, install instructions,
 * and the mechanism table from the hooks-ledger wiki page.
 */
const HOOKS = [
  {
    name: "session-start.sh",
    event: "SessionStart",
    trigger: "每次开会话",
    action: "注入 TeamWorkSpace 资产目录地图（2000 字符上限，只有索引无正文）+ recall 使用指令",
    status: "active",
    install: "PAPERCLIP_COMPANY_ID=<id> scripts/hooks/install-hooks.sh",
  },
  {
    name: "branch-register.sh",
    event: "PreToolUse (Bash)",
    trigger: "git branch / checkout / switch",
    action: "提醒跑 issue start --branch 登记分支和主审会话",
    status: "active",
    install: "同上（三 hook 一并安装）",
  },
  {
    name: "commit-progress.sh",
    event: "PostToolUse (Bash)",
    trigger: "git commit",
    action: "提醒落 progress note + 完成时更新 issue 状态",
    status: "active",
    install: "同上（三 hook 一并安装）",
  },
];

export function Hooks() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const detail = HOOKS.find((h) => h.name === selected);

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Hooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          团队工作流 hook：会话注入资产目录、开分支提醒登记、提交后提醒记进度。三端（claude/codex/zcode）统一安装。
        </p>
      </div>

      <div className="rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Hook</th>
              <th className="px-3 py-2">事件</th>
              <th className="px-3 py-2">触发</th>
              <th className="px-3 py-2">作用</th>
              <th className="px-3 py-2">状态</th>
            </tr>
          </thead>
          <tbody>
            {HOOKS.map((hook) => (
              <tr
                key={hook.name}
                className="cursor-pointer border-b border-border/50 transition-colors hover:bg-accent/30"
                onClick={() => setSelected(selected === hook.name ? null : hook.name)}
              >
                <td className="px-3 py-2.5 font-mono text-xs">{hook.name}</td>
                <td className="px-3 py-2.5 text-xs">{hook.event}</td>
                <td className="px-3 py-2.5 text-xs">{hook.trigger}</td>
                <td className="max-w-sm px-3 py-2.5 text-xs">{hook.action}</td>
                <td className="px-3 py-2.5">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10px] font-medium ${hook.status === "active" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground"}`}>
                    {hook.status === "active" ? "已激活" : "未装"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <h3 className="font-mono text-sm font-semibold">{detail.name}</h3>
          <dl className="mt-2 space-y-1.5 text-sm">
            <div><dt className="inline text-muted-foreground">事件：</dt><dd className="inline">{detail.event}</dd></div>
            <div><dt className="inline text-muted-foreground">触发：</dt><dd className="inline">{detail.trigger}</dd></div>
            <div><dt className="inline text-muted-foreground">作用：</dt><dd className="inline">{detail.action}</dd></div>
            <div>
              <dt className="inline text-muted-foreground">安装：</dt>
              <dd className="inline"><code className="rounded bg-muted/50 px-1 font-mono text-xs">{detail.install}</code></dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            卸载：<code className="rounded bg-muted/50 px-1">--uninstall</code>。三端幂等（[paperclip] 标记合并），装两次不重复。
          </p>
        </div>
      ) : null}

      <div className="rounded-xl border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">历史迁移台账</p>
        <p className="mt-1">五个 Multica hook（agent-guard / branch-register / first-touch-context / issue-create-reminder / worktree-sync）已全量下架。
        职责被 Paperclip 原生机制吸收：建卡提醒→CLI 四规则、分支登记→issue start、首触注入→SessionStart hook、工作树同步→MUL-35 sync 待办。
        详见 Paperclip Wiki <code className="rounded bg-muted/50 px-1">hooks-ledger</code> 页。</p>
      </div>
    </div>
  );
}

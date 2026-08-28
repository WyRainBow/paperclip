import { useState, useRef, useEffect, useCallback } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  name: "这个 Agent 的显示名。",
  title: "组织架构图里显示的职位。",
  role: "组织角色。决定它在架构里的位置和能力。",
  reportsTo: "在组织架构里，这个 Agent 向谁汇报。",
  capabilities: "描述这个 Agent 能做什么。会显示在组织架构图里，也用于任务路由。",
  adapterType: "这个 Agent 怎么跑：本地 CLI（Claude / Codex / OpenCode）、OpenClaw 网关、拉起的子进程，或者通用 HTTP webhook。",
  cwd: "已废弃的本地适配器工作目录兜底项。老 Agent 可能还带着这个值，新配置请改用项目工作区。",
  promptTemplate: "每次心跳都会发送。保持简短、动态，用来交代当前任务，不要塞大段静态说明。支持 {{ agent.id }}、{{ agent.name }}、{{ agent.role }} 等模板变量。",
  model: "覆盖适配器默认使用的模型。",
  thinkingEffort: "控制模型的推理深度。可用取值随适配器和模型不同。",
  chrome: "传 --chrome，开启 Claude 的 Chrome 集成。",
  dangerouslySkipPermissions: "在适配器支持时自动批准权限询问，让它能无人值守地跑。",
  dangerouslyBypassSandbox: "让 Codex 不受沙箱限制地运行。需要读写文件或访问网络时必须开。",
  search: "允许 Codex 在运行时联网搜索。",
  fastMode: "开启 Codex Fast 模式。它烧额度和 token 的速度快得多，支持 GPT-5.6、GPT-5.5、GPT-5.4 以及手填的 Codex 模型 id。",
  workspaceStrategy: "Paperclip 用什么方式给这个 Agent 准备执行工作区。常规的 cwd 执行保持 project_primary，需要按 issue 隔离检出时用 git_worktree。",
  workspaceBaseRef: "创建 worktree 分支时用的基准 git ref。留空则用解析出的工作区 ref 或 HEAD。",
  workspaceBranchTemplate: "派生分支的命名模板。支持 {{issue.identifier}}、{{issue.title}}、{{agent.name}}、{{project.id}}、{{workspace.repoRef}} 和 {{slug}}。",
  worktreeParentDir: "派生 worktree 建在哪个目录下。支持绝对路径、~ 开头的路径和仓库相对路径。",
  runtimeServicesJson: "可选的工作区运行时服务定义。用于挂在工作区上的共享应用服务、worker 或其他长期运行的配套进程。",
  maxTurnsPerRun: "每次心跳运行最多允许多少个 agent 轮次（工具调用）。",
  command: "要执行的命令（如 node、python）。",
  localCommand: "覆盖适配器要调用的 CLI 命令路径（如 /usr/local/bin/claude、codex、opencode）。",
  args: "命令行参数，用逗号分隔。",
  extraArgs: "本地适配器的额外 CLI 参数，用逗号分隔。",
  envVars: "注入到适配器进程的环境变量。可以填明文值，也可以填密钥引用。",
  secretAccess:
    "这个 Agent 能取到哪些密钥。环境变量类绑定在运行开始时注入，API 访问类绑定通过与运行绑定的 Agent 接口按需取，永远不写进环境变量。",
  bootstrapPrompt: "只在 Paperclip 开启新会话时发送一次。放稳定的初始化说明，不适合每次心跳都重复的内容。",
  payloadTemplateJson: "可选 JSON，在 Paperclip 补上它自己的唤醒和工作区字段之前，先合并进远程适配器的请求体。",
  webhookUrl: "这个 Agent 被调用时，接收 POST 请求的地址。",
  heartbeatInterval: "按定时器自动运行这个 Agent。适合定期检查有没有新活这类任务。",
  intervalSec: "两次自动心跳之间隔多少秒。",
  timeoutSec: "一次运行最多跑多少秒，超时就终止。填 0 表示不限时。",
  graceSec: "发出中断信号之后，等多少秒再强制杀掉进程。",
  wakeOnDemand: "允许通过派活、API 调用、界面操作或自动化系统唤醒这个 Agent。",
  cooldownSec: "两次心跳运行之间至少间隔多少秒。",
  maxConcurrentRuns: "这个 Agent 最多能同时跑几个心跳运行。",
  maxTurnContinuationEnabled: "适配器因为跑满单次轮次上限而停下时，自动排队有限次数的续跑。",
  maxTurnContinuationMaxAttempts: "一次轮次耗尽停止后，最多自动续跑几次。这个数和单次运行的轮次上限是两回事。",
  maxTurnContinuationDelaySec: "每次续跑之前先等多少秒。",
  budgetMonthlyCents: "每月支出上限，单位为分。填 0 表示不限。",
};

import { getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels = getAdapterLabels();

export const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/* ---- Primitive components ---- */

export function HintIcon({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex text-muted-foreground/50 hover:text-muted-foreground transition-colors">
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      {children}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  toggleTestId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  toggleTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {hint && <HintIcon text={hint} />}
      </div>
      {/* Gallery feedback r3: was a hand-rolled h-5 w-9 pill with a bg-green-600
          track — the app's second switch implementation. Converged on the one
          canonical ToggleSwitch (status-green on-state), DESIGN.md principle 1. */}
      <ToggleSwitch
        data-testid={toggleTestId}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export function ToggleWithNumber({
  label,
  hint,
  checked,
  onCheckedChange,
  number,
  onNumberChange,
  numberLabel,
  numberHint,
  numberPrefix,
  showNumber,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  number: number;
  onNumberChange: (v: number) => void;
  numberLabel: string;
  numberHint?: string;
  numberPrefix?: string;
  showNumber: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          {hint && <HintIcon text={hint} />}
        </div>
        <ToggleSwitch
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {showNumber && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {numberPrefix && <span>{numberPrefix}</span>}
          <input
            type="number"
            className="w-16 rounded-md border border-border px-2 py-0.5 bg-transparent outline-none text-xs font-mono text-center"
            value={number}
            onChange={(e) => onNumberChange(Number(e.target.value))}
          />
          <span>{numberLabel}</span>
          {numberHint && <HintIcon text={numberHint} />}
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({
  title,
  icon,
  open,
  onToggle,
  bordered,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(bordered && "border-t border-border")}>
      <button
        className="flex items-center gap-2 w-full px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/30 transition-colors"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {title}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

export function AutoExpandTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minRows,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minRows?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      style={{ minHeight }}
    />
  );
}

/**
 * Text input that manages internal draft state.
 * Calls `onCommit` on blur (and optionally on every change if `immediate` is set).
 */
export function DraftInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      {...props}
    />
  );
}

/**
 * Auto-expanding textarea with draft state and blur-commit.
 */
export function DraftTextarea({
  value,
  onCommit,
  immediate,
  placeholder,
  minRows,
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  placeholder?: string;
  minRows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [draft, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ minHeight }}
    />
  );
}

/**
 * Number input with draft state and blur-commit.
 */
export function DraftNumberInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: number;
  onCommit: (v: number) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "type">) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(Number(e.target.value) || 0);
      }}
      onBlur={() => {
        const num = Number(draft) || 0;
        if (num !== value) onCommit(num);
      }}
      {...props}
    />
  );
}

/**
 * "Choose" button that opens a dialog explaining the user must manually
 * type the path due to browser security limitations.
 */
export function ChoosePathButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
        onClick={() => setOpen(true)}
      >
        Choose
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Specify path manually</DialogTitle>
            <DialogDescription>
              Browser security blocks apps from reading full local paths via a file picker.
              Copy the absolute path and paste it into the input.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">macOS (Finder)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Find the folder in Finder.</li>
                <li>Hold <kbd>Option</kbd> and right-click the folder.</li>
                <li>Click "Copy &lt;folder name&gt; as Pathname".</li>
                <li>Paste the result into the path input.</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">Windows (File Explorer)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Find the folder in File Explorer.</li>
                <li>Hold <kbd>Shift</kbd> and right-click the folder.</li>
                <li>Click "Copy as path".</li>
                <li>Paste the result into the path input.</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">Terminal fallback (macOS/Linux)</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>Run <code>cd /path/to/folder</code>.</li>
                <li>Run <code>pwd</code>.</li>
                <li>Copy the output and paste it into the path input.</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Label + input rendered on the same line (inline layout for compact fields).
 */
export function InlineField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 shrink-0">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      <div className="w-24 ml-auto">{children}</div>
    </div>
  );
}

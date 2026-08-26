export function Hooks() {
  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold text-foreground">Hooks</h1>
      <div className="rounded-xl border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
        Hooks 迁入中。五个 Multica 工作流 hook（agent-guard / branch-register / first-touch-context /
        issue-create-reminder / worktree-sync）的职责迁移与下架在 MUL-36 / MUL-41 推进，
        落地后这里统一管理团队 hooks。
      </div>
    </div>
  );
}

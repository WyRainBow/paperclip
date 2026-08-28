import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, UserCheck } from "lucide-react";
import type { InstanceGeneralSettings } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 裁决模式 (MUL-131) — who closes finished work. One clickable control,
 * modeled on Claude Code's permission-mode picker:
 *
 * - 委托 (auto, default): the implementing agent closes its own card (done)
 *   and leaves a decision record. Nothing waits in the inbox.
 * - 亲审 (manual): agents may only park work in in_review; the done verb is
 *   reserved for a person, enforced server-side on the status patch.
 *
 * Lives on the Decisions desk header because that is where mode-manual review
 * items land. The setting is instance-general, board-writable; agents feel it
 * only through the server gate, so flipping it needs no agent restart.
 */
export type AdjudicationMode = "auto" | "manual";

export const ADJUDICATION_MODES: {
  value: AdjudicationMode;
  label: string;
  description: string;
}[] = [
  { value: "auto", label: "委托", description: "Agent 自裁收卡，决策卡留痕" },
  { value: "manual", label: "亲审", description: "收卡前等老板在收件箱批" },
];

export function resolveAdjudicationMode(
  settings: Pick<InstanceGeneralSettings, "adjudicationMode"> | null | undefined,
): AdjudicationMode {
  return settings?.adjudicationMode === "manual" ? "manual" : "auto";
}

export function AdjudicationModePicker() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const mode = resolveAdjudicationMode(settings);
  const mutation = useMutation({
    mutationFn: (next: AdjudicationMode) =>
      instanceSettingsApi.updateGeneral({ adjudicationMode: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
  });
  const current = ADJUDICATION_MODES.find((option) => option.value === mode) ?? ADJUDICATION_MODES[0]!;

  return (
    <Select
      value={mode}
      onValueChange={(value) => mutation.mutate(value as AdjudicationMode)}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        size="sm"
        aria-label="裁决模式"
        className="w-auto min-w-0 gap-1.5 text-xs"
        data-testid="adjudication-mode-trigger"
      >
        {mode === "auto" ? (
          <BadgeCheck className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" aria-hidden />
        ) : (
          <UserCheck className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        )}
        {/* Explicit children suppress Radix's value-subtree portal so the
            closed trigger shows the label only (same trap as PAP-17293). */}
        <SelectValue>{current.label}</SelectValue>
      </SelectTrigger>
      {/* popper drops the menu below the trigger; the default item-aligned
          mode overlays it (user 2026-08-28 screenshot). Same choice as
          SummarySlotCard. */}
      <SelectContent align="end" position="popper">
        {ADJUDICATION_MODES.map((option) => (
          <SelectItem key={option.value} value={option.value} textValue={option.label}>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {option.label}
                {option.value === "auto" ? (
                  <span className="ml-1.5 rounded bg-muted px-1 py-px text-(length:--text-micro) text-muted-foreground">默认</span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

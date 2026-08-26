import { Languages } from "lucide-react";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { currentUiLanguage, setUiLanguage } from "../i18n";
import { useTranslation } from "../i18n";

type LanguageToggleVariant = "icon" | "menu-action";

interface LanguageToggleProps {
  className?: string;
  /**
   * `icon` (default): compact icon button — one click flips between English
   * and Simplified Chinese.
   *
   * `menu-action`: full-width row with label + description + icon — matches
   * the surrounding `MenuAction` rows in `SidebarAccountMenu`.
   */
  variant?: LanguageToggleVariant;
  /** Called after the language flips; popover menus use it to dismiss. */
  onAfterToggle?: () => void;
}

const OTHER_LANGUAGE: Record<string, "en" | "zh-CN"> = {
  en: "zh-CN",
  "zh-CN": "en",
};

/**
 * Canonical language toggle. One click flips the UI between English and
 * Simplified Chinese and best-effort persists the same preference as the
 * instance `agentOutputLanguage` setting so agent-authored content follows the
 * board's language. The PATCH failing (offline, no board session) must not
 * block the UI switch.
 */
export function LanguageToggle({ className, variant = "icon", onAfterToggle }: LanguageToggleProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const handleToggle = useCallback(() => {
    const next = OTHER_LANGUAGE[currentUiLanguage()] ?? "zh-CN";
    setUiLanguage(next);
    onAfterToggle?.();
    void instanceSettingsApi
      .updateGeneral({ agentOutputLanguage: next })
      .then((general) => {
        queryClient.setQueryData(queryKeys.instance.generalSettings, general);
      })
      .catch(() => {
        // UI language still switched; agent language stays as-is until the
        // board retries from the settings page.
      });
  }, [onAfterToggle, queryClient]);

  const label = t("language.toggle.label");
  const description = t("language.toggle.description");

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
          className,
        )}
        onClick={handleToggle}
        aria-label={label}
      >
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Languages className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={handleToggle}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground", className)}
    >
      <Languages />
    </Button>
  );
}

import { useState, useMemo } from "react";
import {
  type LucideIcon,
} from "lucide-react";
import { AGENT_ICON_NAMES, type AgentIconName } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AGENT_ICONS, getAgentIcon } from "../lib/agent-icons";

const DEFAULT_ICON: AgentIconName = "bot";

interface AgentIconProps {
  icon: string | null | undefined;
  className?: string;
}

export function agentCustomIcon(agent: { icon?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): string | null {
  const url = agent?.metadata?.customIcon;
  return typeof url === "string" ? url : null;
}

/**
 * One-stop agent mark (MUL-152): pass the agent, get its brand logo with the
 * lucide fallback baked in. Call sites that hand-roll icon={agent.icon} keep
 * missing metadata.customIcon — this is the seam that ends that class of bug.
 */
export function AgentMark({ agent, className }: { agent?: { icon?: string | null; metadata?: Record<string, unknown> | null } | null; className?: string }) {
  return <AgentIcon icon={agent?.icon ?? null} customIconUrl={agentCustomIcon(agent)} className={className} />;
}

export function AgentIcon({ icon, customIconUrl, className }: AgentIconProps & { customIconUrl?: string | null }) {
  if (customIconUrl) {
    return <img src={customIconUrl} alt="" className={cn("rounded-sm object-cover", className)} />;
  }
  const Icon = getAgentIcon(icon);
  return <Icon className={className} />;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string) => void;
  children: React.ReactNode;
}

export function AgentIconPicker({ value, onChange, children }: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const entries = AGENT_ICON_NAMES.map((name) => [name, AGENT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <Input
          placeholder="Search icons..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 h-8 text-sm"
          autoFocus
        />
        <div className="grid grid-cols-7 gap-1 max-h-48 overflow-y-auto">
          {filtered.map(([name, Icon]) => (
            <button
              key={name}
              onClick={() => {
                onChange(name);
                setOpen(false);
                setSearch("");
              }}
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary"
              )}
              title={name}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-7 text-xs text-muted-foreground text-center py-2">No icons match</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

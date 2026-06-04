import { cn } from "@/lib/utils";
import { runStatusLabel } from "@/lib/automation-log-user";

const STYLES: Record<string, string> = {
  RUNNING: "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 dark:text-emerald-300",
  PENDING: "bg-sky-500/15 text-sky-800 ring-sky-500/30 dark:text-sky-300",
  PAUSED_OTP: "bg-amber-500/15 text-amber-900 ring-amber-500/30 dark:text-amber-200",
  PAUSED_USER: "bg-amber-500/15 text-amber-900 ring-amber-500/30 dark:text-amber-200",
  FAILED: "bg-destructive/15 text-destructive ring-destructive/30",
  STOPPED: "bg-muted text-muted-foreground ring-border",
  COMPLETED: "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 dark:text-emerald-300",
};

export function RunStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        STYLES[status] ?? "bg-muted text-muted-foreground ring-border",
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}

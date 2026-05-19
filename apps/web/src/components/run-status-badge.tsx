import { cn } from "@/lib/utils";
import { runStatusLabel } from "@/lib/automation-log-user";

const STYLES: Record<string, string> = {
  RUNNING: "bg-emerald-100 text-emerald-900 ring-emerald-200",
  PENDING: "bg-sky-100 text-sky-900 ring-sky-200",
  PAUSED_OTP: "bg-amber-100 text-amber-950 ring-amber-200",
  PAUSED_USER: "bg-amber-100 text-amber-950 ring-amber-200",
  FAILED: "bg-red-100 text-red-900 ring-red-200",
  STOPPED: "bg-zinc-200 text-zinc-800 ring-zinc-300",
  COMPLETED: "bg-emerald-100 text-emerald-900 ring-emerald-200",
};

export function RunStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        STYLES[status] ?? "bg-zinc-100 text-zinc-800 ring-zinc-200",
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}

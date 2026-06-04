import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type StatCardProps = {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  variant?: "default" | "success" | "warning" | "muted";
  className?: string;
};

const iconBg = {
  default: "bg-primary/10 text-primary",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  muted: "bg-muted text-muted-foreground",
};

export function StatCard({ label, value, hint, icon: Icon, variant = "default", className }: StatCardProps) {
  return (
    <div
      className={cn(
        "flex gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-card transition-shadow hover:shadow-md",
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            iconBg[variant],
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={2} />
        </div>
      ) : null}
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">{value}</p>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

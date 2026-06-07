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
        "group flex gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-md sm:gap-4 sm:p-5",
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-105 sm:h-11 sm:w-11",
            iconBg[variant],
          )}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={2} />
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium leading-tight text-muted-foreground sm:text-xs">{label}</p>
        <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground sm:mt-1 sm:text-xl">{value}</p>
        {hint ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground sm:mt-1 sm:text-xs sm:leading-relaxed">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

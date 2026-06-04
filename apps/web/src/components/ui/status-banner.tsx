import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type StatusBannerProps = {
  variant: "success" | "error" | "warning";
  title: string;
  children?: React.ReactNode;
  className?: string;
};

export function StatusBanner({ variant, title, children, className }: StatusBannerProps) {
  const isSuccess = variant === "success";
  const isWarning = variant === "warning";
  return (
    <div
      role={isSuccess ? "status" : "alert"}
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3.5 text-sm shadow-sm",
        isSuccess
          ? "border-emerald-500/25 bg-emerald-500/8 text-foreground"
          : isWarning
            ? "border-amber-500/25 bg-amber-500/8 text-foreground"
            : "border-destructive/25 bg-destructive/8 text-foreground",
        className,
      )}
    >
      {isSuccess ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : isWarning ? (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        {children ? <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

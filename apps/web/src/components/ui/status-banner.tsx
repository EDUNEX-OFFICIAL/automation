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
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        isSuccess
          ? "border-green-200 bg-green-50 text-green-900"
          : isWarning
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-red-200 bg-red-50 text-red-900",
        className,
      )}
    >
      {isSuccess ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden />
      ) : isWarning ? (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-[13px] opacity-90">{children}</div> : null}
      </div>
    </div>
  );
}


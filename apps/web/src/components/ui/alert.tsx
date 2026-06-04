import { AlertCircle, CheckCircle2, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type AlertProps = {
  variant?: "error" | "success" | "warning" | "info";
  title?: string;
  children: React.ReactNode;
  className?: string;
};

const styles = {
  error: "border-destructive/30 bg-destructive/10 text-foreground",
  success: "border-emerald-500/30 bg-emerald-500/10 text-foreground",
  warning: "border-amber-500/30 bg-amber-500/10 text-foreground",
  info: "border-info/30 bg-info/10 text-foreground",
};

const icons = {
  error: AlertCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
  info: Info,
};

export function Alert({ variant = "info", title, children, className }: AlertProps) {
  const Icon = icons[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-xl border px-4 py-3 text-sm", styles[variant], className)}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 opacity-80" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={cn(title && "mt-1", "text-muted-foreground [&_strong]:text-foreground")}>
          {children}
        </div>
      </div>
    </div>
  );
}

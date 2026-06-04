import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  variant?: "light" | "dark";
  showTagline?: boolean;
};

export function BrandLogo({ className, variant = "dark", showTagline = false }: BrandLogoProps) {
  const isLight = variant === "light";
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold tracking-tight shadow-sm",
          isLight
            ? "bg-white/15 text-white ring-1 ring-white/25"
            : "bg-primary text-primary-foreground ring-1 ring-primary/20",
        )}
        aria-hidden
      >
        G
      </div>
      <div className="min-w-0 leading-tight">
        <p
          className={cn(
            "truncate text-[15px] font-semibold tracking-tight",
            isLight ? "text-white" : "text-foreground",
          )}
        >
          GDMS Automation
        </p>
        {showTagline ? (
          <p className={cn("truncate text-[11px]", isLight ? "text-white/65" : "text-muted-foreground")}>
            Dealer operations platform
          </p>
        ) : null}
      </div>
    </div>
  );
}

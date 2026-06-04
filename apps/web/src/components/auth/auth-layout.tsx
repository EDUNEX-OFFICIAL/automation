import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export type AuthHighlight = {
  title: string;
  description: string;
  icon: LucideIcon;
};

type AuthLayoutProps = {
  children: ReactNode;
  title: string;
  subtitle?: string;
  highlights?: AuthHighlight[];
};

function HighlightCard({
  item,
  variant,
}: {
  item: AuthHighlight;
  variant: "sidebar" | "mobile";
}) {
  const Icon = item.icon;
  const isSidebar = variant === "sidebar";

  return (
    <div
      className={cn(
        "rounded-xl border backdrop-blur-sm",
        isSidebar
          ? "border-white/10 bg-white/5 px-5 py-5"
          : "border-border/60 bg-card px-5 py-4 shadow-sm",
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            isSidebar ? "bg-white/10 text-white" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p
            className={cn(
              "text-sm font-semibold leading-snug",
              isSidebar ? "text-white" : "text-foreground",
            )}
          >
            {item.title}
          </p>
          <p
            className={cn(
              "text-[13px] leading-relaxed",
              isSidebar ? "text-white/75" : "text-muted-foreground",
            )}
          >
            {item.description}
          </p>
        </div>
      </div>
    </div>
  );
}

export function AuthLayout({ children, title, subtitle, highlights }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="relative hidden w-full max-w-[440px] flex-col auth-panel-gradient px-10 pb-10 pt-10 text-white lg:flex xl:max-w-[480px]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-sm font-semibold shadow-lg ring-1 ring-white/20">
            G
          </div>
          <p className="text-sm font-semibold tracking-tight">GDMS Automation</p>
        </div>

        {highlights && highlights.length > 0 ? (
          <div className="flex flex-1 flex-col justify-center space-y-4 py-10">
            {highlights.map((item) => (
              <HighlightCard key={item.title} item={item} variant="sidebar" />
            ))}
          </div>
        ) : (
          <div className="flex-1" aria-hidden />
        )}

        <p className="pt-6 text-xs text-white/40">© GDMS Automation</p>
      </aside>

      <main className="relative flex flex-1 flex-col justify-center px-4 py-12 sm:px-10 lg:px-16 lg:py-16">
        <div className="absolute right-4 top-4 sm:right-8 sm:top-8">
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-8 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-sm">
              G
            </div>
          </div>
          <div className="mb-8 space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
            {subtitle ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>

          {highlights && highlights.length > 0 ? (
            <div className="mb-8 space-y-4 lg:hidden">
              {highlights.map((item) => (
                <HighlightCard key={item.title} item={item} variant="mobile" />
              ))}
            </div>
          ) : null}

          {children}
        </div>
      </main>
    </div>
  );
}

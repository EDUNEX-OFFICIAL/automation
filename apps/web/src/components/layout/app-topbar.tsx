"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { AppUserMenu } from "@/components/app-user-menu";
import { breadcrumbsForPath } from "@/lib/breadcrumbs";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

export function AppTopbar({ className }: { className?: string }) {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const crumbs = breadcrumbsForPath(pathname, role);

  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex h-[var(--topbar-height)] shrink-0 items-center justify-between gap-4 border-b border-border/80 bg-card/95 px-4 shadow-sm backdrop-blur-xl sm:px-6 lg:px-8",
        className,
      )}
    >
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((c, i) => (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {i > 0 ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
              ) : null}
              {c.href ? (
                <Link
                  href={c.href}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="truncate font-medium text-foreground">{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="flex shrink-0 items-center gap-1.5">
        <NotificationBell />
        <ThemeToggle />
        <AppUserMenu />
      </div>
    </header>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LiveRunNavBadge } from "@/components/live-run-nav-badge";
import { ROLE_LABELS, navSectionsForRole, type AppRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import { resolveAvatarSrc } from "@/lib/avatar";

type AppSidebarProps = {
  onNavigate?: () => void;
  className?: string;
};

export function AppSidebar({ onNavigate, className }: AppSidebarProps) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const role = user?.role;
  const sections = navSectionsForRole(role);
  const avatarSrc = resolveAvatarSrc(user?.avatarUrl ?? null);
  const label = user?.displayLabel?.trim() || user?.displayName?.trim() || user?.username || "";
  const initials = (user?.displayName?.trim() || user?.username || "?").slice(0, 2).toUpperCase();

  return (
    <aside
      className={cn(
        "flex h-full w-[var(--sidebar-width)] flex-col border-r border-border/80 bg-sidebar text-sidebar-foreground shadow-[1px_0_0_0_hsl(var(--border)/0.5)]",
        className,
      )}
    >
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 px-4">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-sm"
          aria-hidden
        >
          G
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
            GDMS Automation
          </p>
        </div>
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3" aria-label="Main navigation">
        {sections.map((section) => (
          <div key={section.title} className="mb-4 last:mb-0">
            <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">
              {section.title}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((n) => {
                const Icon = n.icon;
                const active = pathname?.startsWith(n.href);
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "nav-pill-active"
                          : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-[18px] w-[18px] shrink-0",
                          active ? "text-primary" : "opacity-70",
                        )}
                        strokeWidth={active ? 2.25 : 2}
                      />
                      <span className="flex min-w-0 flex-1 items-center truncate">
                        {n.label}
                        {n.href === "/live-session" ? <LiveRunNavBadge /> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {user ? (
        <div className="shrink-0 border-t border-border/60 p-3">
          <Link
            href="/profile"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-sidebar-hover"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 ring-1 ring-border/80">
              {avatarSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs font-semibold text-primary">
                  {initials}
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-sidebar-foreground">{label}</span>
              <span className="block truncate text-xs text-sidebar-muted">
                {ROLE_LABELS[user.role as AppRole] ?? user.role}
              </span>
            </span>
          </Link>
        </div>
      ) : null}
    </aside>
  );
}

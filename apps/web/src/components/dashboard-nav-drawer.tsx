"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
  Activity,
  LayoutDashboard,
  Settings,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export const dashboardNav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/live-session", label: "Live session", icon: Activity },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/users", label: "Users", icon: UserCog },
];

type DashboardNavDrawerProps = {
  open: boolean;
  onClose: () => void;
  userEmail?: string | null;
};

export function DashboardNavDrawer({ open, onClose, userEmail }: DashboardNavDrawerProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 xl:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-zinc-900/40 backdrop-blur-md transition-opacity duration-500 ease-out",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          "nav-bloom-panel absolute left-3 right-3 top-[4.25rem] max-h-[min(32rem,calc(100vh-5.5rem))] overflow-hidden rounded-[1.75rem] border border-zinc-200/80 bg-white shadow-[0_24px_80px_-12px_rgba(0,0,0,0.18)]",
          open ? "nav-bloom-open" : "nav-bloom-closed",
        )}
      >
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-zinc-200/90 to-zinc-100/40 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-40 w-40 rounded-full bg-zinc-900/[0.04] blur-3xl" />

        <div className="relative flex items-start justify-between gap-3 border-b border-zinc-100 px-5 pb-4 pt-5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">Navigate</p>
            <p className="mt-0.5 text-sm font-medium text-zinc-800">Workspace</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 transition hover:bg-zinc-200 hover:text-zinc-900"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="relative space-y-1.5 overflow-y-auto px-3 py-4">
          {dashboardNav.map((item, i) => {
            const active = pathname?.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "nav-bloom-item group flex items-center gap-3 rounded-2xl px-3 py-3.5 transition-colors",
                  open && "nav-bloom-item-visible",
                  active
                    ? "bg-zinc-900 text-white shadow-md shadow-zinc-900/15"
                    : "text-zinc-700 hover:bg-zinc-50",
                )}
                style={{ animationDelay: open ? `${80 + i * 55}ms` : "0ms" }}
              >
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105",
                    active ? "bg-white/15" : "bg-zinc-100 text-zinc-600",
                  )}
                >
                  <Icon className="h-[1.15rem] w-[1.15rem]" strokeWidth={active ? 2.25 : 2} />
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold leading-tight">{item.label}</span>
                  {active && (
                    <span className="text-[11px] font-medium text-white/60">Current page</span>
                  )}
                </span>
              </Link>
            );
          })}
        </nav>

        {userEmail ? (
          <div className="relative border-t border-zinc-100 px-5 py-4">
            <p className="truncate text-xs text-zinc-500">{userEmail}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

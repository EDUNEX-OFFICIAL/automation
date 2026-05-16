"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { OtpModal } from "@/components/otp-modal";
import { useRealtimeSocket } from "@/hooks/use-realtime-socket";
import { DashboardNavDrawer, dashboardNav } from "@/components/dashboard-nav-drawer";
import { MenuToggle } from "@/components/menu-toggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuthStore();
  const [navOpen, setNavOpen] = useState(false);
  useRealtimeSocket();

  return (
    <div className="min-h-screen bg-zinc-50">
      <OtpModal />
      <DashboardNavDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        userEmail={user?.email}
      />

      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <MenuToggle
              open={navOpen}
              onClick={() => setNavOpen((v) => !v)}
              className="shrink-0 xl:hidden"
            />
            <Link href="/dashboard" className="min-w-0 truncate font-semibold text-zinc-900">
              GDMS Automation
            </Link>
          </div>

          <nav className="hidden items-center gap-0.5 xl:flex" aria-label="Main">
            {dashboardNav.map((n) => {
              const Icon = n.icon;
              const active = pathname?.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-zinc-900 font-medium text-white"
                      : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={active ? 2.25 : 2} />
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="hidden max-w-[12rem] truncate text-right text-xs text-zinc-500 sm:block xl:max-w-[14rem]">
            {user?.email}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 sm:py-6 lg:py-8">{children}</main>
    </div>
  );
}

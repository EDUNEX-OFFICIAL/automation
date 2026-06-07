"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { AppUserMenu } from "@/components/app-user-menu";
import { OtpModal } from "@/components/otp-modal";
import { RoleHomeRedirect } from "@/components/role-home-redirect";
import { DashboardNavDrawer } from "@/components/dashboard-nav-drawer";
import { MenuToggle } from "@/components/menu-toggle";
import { useHealAutomationOnRefresh } from "@/hooks/use-heal-automation-on-refresh";
import { reconcileLiveRunForCurrentUser } from "@/lib/run-ownership";
import { useRealtimeSocket } from "@/hooks/use-realtime-socket";
import { useLiveStore } from "@/stores/live-store";
import { cn } from "@/lib/utils";
import { homePathForRole } from "@/lib/roles";
import { pageTitleForPath } from "@/lib/breadcrumbs";
import { useAuthStore } from "@/stores/auth-store";
import { usePathname } from "next/navigation";

export function AppShell({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  const token = useAuthStore((s) => s.accessToken);
  const pathname = usePathname();
  const otpPending = useLiveStore((s) => s.otpPending);
  const [navOpen, setNavOpen] = useState(false);
  const liveRunId = useLiveStore((s) => s.runId);
  const mobileTitle = pageTitleForPath(pathname);
  useRealtimeSocket();
  useHealAutomationOnRefresh(liveRunId);

  useEffect(() => {
    if (!token) return;
    void reconcileLiveRunForCurrentUser(token);
  }, [token, liveRunId]);

  return (
    <div className="app-canvas gradient-mesh">
      <RoleHomeRedirect />
      <OtpModal />

      <div className="fixed inset-y-0 left-0 z-30 hidden lg:block">
        <AppSidebar />
      </div>

      <DashboardNavDrawer open={navOpen} onClose={() => setNavOpen(false)} />

      <div className="flex min-h-screen flex-col lg:pl-[var(--sidebar-width)]">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border/80 bg-card/95 px-4 shadow-sm backdrop-blur-xl lg:hidden">
          <MenuToggle open={navOpen} onClick={() => setNavOpen((v) => !v)} className="text-foreground" />
          <Link
            href={homePathForRole(role)}
            className="min-w-0 flex-1 truncate text-sm font-semibold"
          >
            {mobileTitle}
          </Link>
          <ThemeToggle />
          <NotificationBell />
          <AppUserMenu />
        </header>

        <div className="hidden lg:flex lg:flex-col">
          <AppTopbar />
        </div>

        <main
          className={cn(
            "page-main mx-auto w-full max-w-[88rem]",
            otpPending && "pb-28 lg:pb-8",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

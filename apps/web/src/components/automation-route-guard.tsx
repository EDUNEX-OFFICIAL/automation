"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { canRunAutomation, homePathForRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";

const AUTOMATION_PATHS = ["/dashboard", "/live-session"];

export function AutomationRouteGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (!role) return;
    const path = window.location.pathname;
    if (AUTOMATION_PATHS.some((p) => path.startsWith(p)) && !canRunAutomation(role)) {
      router.replace(homePathForRole(role));
    }
  }, [role, router]);

  if (role && !canRunAutomation(role)) {
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    if (AUTOMATION_PATHS.some((p) => path.startsWith(p))) return null;
  }

  return <>{children}</>;
}

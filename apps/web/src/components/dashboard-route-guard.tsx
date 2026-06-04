"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isPathAllowedForRole, redirectForBlockedPath } from "@/lib/route-access";
import { useAuthStore } from "@/stores/auth-store";

export function DashboardRouteGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    if (!role || !pathname) return;
    if (!isPathAllowedForRole(pathname, role)) {
      router.replace(redirectForBlockedPath(pathname, role));
    }
  }, [role, pathname, router]);

  if (role && pathname && !isPathAllowedForRole(pathname, role)) {
    return null;
  }

  return <>{children}</>;
}

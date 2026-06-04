"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { homePathForRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";

export function RoleHomeRedirect(): null {
  const router = useRouter();
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const home = homePathForRole(role);

  useEffect(() => {
    if (!role) return;
    if (pathname === "/" || (pathname === "/dashboard" && home !== "/dashboard")) {
      router.replace(home);
    }
  }, [role, pathname, home, router]);

  return null;
}

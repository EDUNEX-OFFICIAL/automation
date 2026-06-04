"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { validateSession } from "@/lib/auth-session";
import { clearLiveStoreOnly } from "@/lib/terminate-live-session";
import { homePathForRole } from "@/lib/roles";
import { useAuthStore } from "@/stores/auth-store";
import { usePersistReady } from "@/hooks/use-persist-ready";

const PUBLIC_PATHS = ["/login", "/register"];

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const storageReady = usePersistReady();
  const token = useAuthStore((s) => s.accessToken);
  const syncUserFromApi = useAuthStore((s) => s.syncUserFromApi);
  const logout = useAuthStore((s) => s.logout);
  const validatedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!storageReady) return;

    const isPublic = PUBLIC_PATHS.some((p) => pathname === p);

    if (!token) {
      validatedTokenRef.current = null;
      if (!isPublic && pathname !== "/") {
        router.replace("/login");
      }
      return;
    }

    if (validatedTokenRef.current === token) {
      if (isPublic) router.replace(homePathForRole(useAuthStore.getState().user?.role));
      return;
    }

    let cancelled = false;
    void (async () => {
      const user = await validateSession(token);
      if (cancelled) return;

      if (!user) {
        validatedTokenRef.current = null;
        logout();
        router.replace("/login");
        return;
      }

      validatedTokenRef.current = token;
      const prevId = useAuthStore.getState().user?.id;
      if (!prevId || prevId !== user.id) clearLiveStoreOnly();
      syncUserFromApi(user);
      if (isPublic) router.replace(homePathForRole(user.role));
    })();

    return () => {
      cancelled = true;
    };
  }, [storageReady, token, pathname, router, syncUserFromApi, logout]);

  return <>{children}</>;
}

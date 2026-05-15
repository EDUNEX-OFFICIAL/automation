"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";

/** Zustand persist localStorage async rehydrate karta hai; iske pehle `accessToken` hamesha null lagta hai. */
export function usePersistReady(): boolean {
  const [ready, setReady] = useState(() => useAuthStore.persist?.hasHydrated?.() ?? false);

  useEffect(() => {
    const api = useAuthStore.persist;
    if (!api) {
      setReady(true);
      return;
    }
    if (api.hasHydrated?.()) {
      setReady(true);
      return;
    }
    const unsub = api.onFinishHydration?.(() => setReady(true));
    return () => unsub?.();
  }, []);

  return ready;
}

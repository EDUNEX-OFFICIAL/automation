"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";

const HYDRATE_FAILSAFE_MS = 2500;

/**
 * Zustand persist rehydrate async hai; agar `localStorage` corrupt / parse fail ho to
 * `onFinishHydration` kabhi success pe fire nahi hota — bina failsafe ke `/` par sirf `null` = white screen.
 */
export function usePersistReady(): boolean {
  const [ready, setReady] = useState(() => useAuthStore.persist?.hasHydrated?.() ?? false);

  useEffect(() => {
    let cancelled = false;
    const done = () => {
      if (!cancelled) setReady(true);
    };

    const api = useAuthStore.persist;
    if (!api) {
      done();
      return () => {
        cancelled = true;
      };
    }
    if (api.hasHydrated?.()) {
      done();
      return () => {
        cancelled = true;
      };
    }

    const unsub = api.onFinishHydration?.(() => done());
    const t = window.setTimeout(done, HYDRATE_FAILSAFE_MS);
    const raf = requestAnimationFrame(() => {
      if (api.hasHydrated?.()) done();
    });

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
      unsub?.();
    };
  }, []);

  return ready;
}

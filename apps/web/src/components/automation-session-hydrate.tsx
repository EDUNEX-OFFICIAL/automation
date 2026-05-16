"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

/** On load, restore last workflow run id so Live session / resume work after refresh. */
export function AutomationSessionHydrate(): null {
  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const hydrated = useAutomationSessionStore.persist?.hasHydrated?.();

  useEffect(() => {
    if (!hydrated || !dealerId) return;
    const saved = useAutomationSessionStore.getState().get(dealerId);
    if (!saved?.runId) return;
    if (!useLiveStore.getState().runId) {
      useLiveStore.getState().setRun(saved.runId);
    }
  }, [hydrated, dealerId]);

  return null;
}

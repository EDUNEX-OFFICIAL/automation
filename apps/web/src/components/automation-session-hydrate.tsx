"use client";

import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { isTerminalRunStatus, terminateLiveSessionLocally } from "@/lib/terminate-live-session";
import { apiFetch } from "@/lib/api";
import { linkLiveSessionToInFlightRun } from "@/lib/saved-automation-session";
import { useLiveStore } from "@/stores/live-store";

/** On load, restore in-flight run id only (not stopped/completed). */
export function AutomationSessionHydrate(): null {
  const token = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id);
  const hydrated = useAutomationSessionStore.persist?.hasHydrated?.();

  useEffect(() => {
    if (!hydrated || !token || !userId) return;
    if (useLiveStore.getState().runId) return;

    const attachSavedOrInFlight = async (): Promise<void> => {
      const saved = useAutomationSessionStore.getState().get(userId);
      if (saved?.runId) {
        try {
          const run = await apiFetch<{ status: string }>(
            `/v1/workflow-runs/${saved.runId}`,
            { token },
          );
          if (isTerminalRunStatus(run.status)) {
            terminateLiveSessionLocally(userId);
          } else if (
            run.status === "RUNNING" ||
            run.status === "PAUSED_OTP" ||
            run.status === "PENDING" ||
            run.status === "PAUSED_USER" ||
            run.status === "FAILED"
          ) {
            useLiveStore.getState().setRun(saved.runId);
            if (run.status === "PAUSED_OTP") {
              useLiveStore.getState().openOtp(saved.runId);
            }
            return;
          } else {
            terminateLiveSessionLocally(userId);
          }
        } catch {
          terminateLiveSessionLocally(userId);
        }
      }
      await linkLiveSessionToInFlightRun(token, userId).catch(() => undefined);
      const linked = useLiveStore.getState().runId;
      if (linked) {
        try {
          const run = await apiFetch<{ status: string }>(`/v1/workflow-runs/${linked}`, { token });
          if (run.status === "PAUSED_OTP") useLiveStore.getState().openOtp(linked);
        } catch {
          /* optional */
        }
      }
    };

    void attachSavedOrInFlight();
  }, [hydrated, userId, token]);

  return null;
}

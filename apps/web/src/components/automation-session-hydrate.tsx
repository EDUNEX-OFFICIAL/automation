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
  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const hydrated = useAutomationSessionStore.persist?.hasHydrated?.();

  useEffect(() => {
    if (!hydrated || !token) return;
    if (useLiveStore.getState().runId) return;

    const attachSavedOrInFlight = async (): Promise<void> => {
      if (dealerId) {
        const saved = useAutomationSessionStore.getState().get(dealerId);
        if (saved?.runId) {
          try {
            const run = await apiFetch<{ status: string }>(
              `/v1/workflow-runs/${saved.runId}`,
              { token },
            );
            if (isTerminalRunStatus(run.status)) {
              terminateLiveSessionLocally(dealerId);
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
              terminateLiveSessionLocally(dealerId);
            }
          } catch {
            terminateLiveSessionLocally(dealerId);
          }
        }
      }
      await linkLiveSessionToInFlightRun(token).catch(() => undefined);
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
  }, [hydrated, dealerId, token]);

  return null;
}

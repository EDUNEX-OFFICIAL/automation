"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { apiFetch } from "@/lib/api";
import {
  isTerminalRunStatus,
  terminateLiveSessionLocally,
} from "@/lib/terminate-live-session";
import { useAuthStore } from "@/stores/auth-store";

type WorkflowRunRow = { id: string; status: string };

/**
 * On each page load / route change / tab focus: reconcile stale runs and heal the active run.
 * Replaces manual "refresh + Retry queue" for operators.
 */
export function useHealAutomationOnRefresh(activeRunId: string | null): void {
  const token = useAuthStore((s) => s.accessToken);
  const dealerId = useAuthStore((s) => s.user?.dealerId);
  const pathname = usePathname();
  const lastHealKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token || !dealerId) return;

    const heal = async (reason: "mount" | "focus"): Promise<void> => {
      const healKey = `${pathname}:${activeRunId ?? ""}`;
      if (reason === "mount") {
        if (lastHealKeyRef.current === healKey) return;
        lastHealKeyRef.current = healKey;
      }

      try {
        await apiFetch("/v1/workflow-runs/reconcile-stale", {
          method: "POST",
          token,
          body: JSON.stringify({ dealerId }),
        });
      } catch {
        /* ignore */
      }

      if (!activeRunId) return;

      try {
        const run = await apiFetch<WorkflowRunRow>(`/v1/workflow-runs/${activeRunId}`, { token });
        if (
          isTerminalRunStatus(run.status) ||
          run.status === "PAUSED_USER" ||
          run.status === "FAILED"
        ) {
          terminateLiveSessionLocally(dealerId);
          return;
        }
        if (run.status === "PENDING" && reason === "mount") {
          await apiFetch(`/v1/workflow-runs/${activeRunId}/requeue`, {
            method: "POST",
            token,
            body: JSON.stringify({}),
          });
        }
      } catch {
        /* ignore */
      }
    };

    void heal("mount");

  }, [token, dealerId, pathname, activeRunId]);
}

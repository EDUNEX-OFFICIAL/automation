"use client";

import { useEffect, useState } from "react";
import { runStatusLabel } from "@/lib/automation-log-user";
import { apiFetch } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";
import { cn } from "@/lib/utils";

const BADGE_STYLES: Record<string, string> = {
  RUNNING: "bg-emerald-500",
  PENDING: "bg-sky-500",
  PAUSED_OTP: "bg-amber-500",
  PAUSED_USER: "bg-amber-500",
  FAILED: "bg-red-500",
};

/** Small status pill on the Live session nav link when a run is linked. */
export function LiveRunNavBadge() {
  const token = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.user?.id);
  const runId = useLiveStore((s) => s.runId);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !runId || !userId) {
      setStatus(null);
      return;
    }
    let stop = false;
    const poll = (): void => {
      void apiFetch<{ status: string; startedByUserId?: string | null }>(
        `/v1/workflow-runs/${runId}`,
        { token },
      )
        .then((r) => {
          if (stop) return;
          if (r.startedByUserId && r.startedByUserId !== userId) {
            setStatus(null);
            return;
          }
          setStatus(r.status);
        })
        .catch(() => {
          if (!stop) setStatus(null);
        });
    };
    poll();
    const t = window.setInterval(poll, 5000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [token, runId, userId]);

  if (!runId || !status) return null;
  if (status === "COMPLETED" || status === "STOPPED") return null;

  return (
    <span
      className={cn(
        "ml-1.5 inline-flex max-w-[5.5rem] truncate rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white",
        BADGE_STYLES[status] ?? "bg-muted-foreground",
      )}
      title={runStatusLabel(status)}
    >
      {runStatusLabel(status)}
    </span>
  );
}

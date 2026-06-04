"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";
import { useLeadsStore } from "@/stores/leads-store";
import { SocketEvents, automationRunParamsSchema } from "@gdms/shared";
import { apiFetch, getApiUrl, getSocketIoSettings } from "@/lib/api";
import type { WorkflowRunDetail } from "@/lib/saved-automation-session";
import { useAutomationSessionStore } from "@/stores/automation-session-store";

/** Ignore automation socket payloads unless they belong to the linked run. */
function isActiveWorkflowRun(workflowRunId: string | undefined): boolean {
  const active = useLiveStore.getState().runId;
  return Boolean(active && workflowRunId && workflowRunId === active);
}

export function useRealtimeSocket(): void {
  const token = useAuthStore((s) => s.accessToken);
  const runId = useLiveStore((s) => s.runId);
  const socketRef = useRef<Socket | null>(null);
  const lastSocketErrorLogAtRef = useRef(0);
  const inquiriesSuffixRef = useRef("");
  const inquiriesQuerySuffix = useLeadsStore((s) => s.inquiriesQuerySuffix);

  const { pushLog, setFrame, setLastStep, openOtp, setRealtimeConnected, setWorkflowDone } =
    useLiveStore();

  /** Live store actions used inside socket callbacks — identities are stable via zustand. */
  const storeRef = useRef({
    pushLog,
    setFrame,
    setLastStep,
    openOtp,
    setRealtimeConnected,
    setWorkflowDone,
  });
  storeRef.current = {
    pushLog,
    setFrame,
    setLastStep,
    openOtp,
    setRealtimeConnected,
    setWorkflowDone,
  };

  const setRows = useLeadsStore((s) => s.setRows);
  const setCallPhase = useLeadsStore((s) => s.setCallPhase);

  useEffect(() => {
    inquiriesSuffixRef.current = inquiriesQuerySuffix;
  }, [inquiriesQuerySuffix]);

  useEffect(() => {
    if (!token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      useLiveStore.getState().setRealtimeConnected(false);
      return;
    }
    const { uri, path } = getSocketIoSettings();
    const transports = ["polling", "websocket"] as const;

    const socket = io(uri, {
      ...(path ? { path } : {}),
      auth: { token },
      transports: [...transports],
      withCredentials: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      reconnectionAttempts: 50,
    });
    socketRef.current = socket;

    socket.on(SocketEvents.OTP_REQUIRED, (p: { workflowRunId: string }) => {
      void (async () => {
        const me = useAuthStore.getState().user;
        if (!me?.id || !token) return;
        try {
          const run = await apiFetch<WorkflowRunDetail>(
            `/v1/workflow-runs/${encodeURIComponent(p.workflowRunId)}`,
            { token },
          );
          if (run.startedByUserId && run.startedByUserId !== me.id) return;
          const live = useLiveStore.getState();
          live.setRun(p.workflowRunId);
          storeRef.current.openOtp(p.workflowRunId);
          const params = automationRunParamsSchema.safeParse(run.runParams);
          if (params.success) {
            useAutomationSessionStore.getState().save(me.id, {
              runId: run.id,
              dealerId: run.dealerId,
              operation: params.data.operation,
              sources: params.data.sources,
              subSources: params.data.subSources,
            });
          }
        } catch {
          /* ignore other users' OTP or stale runs */
        }
      })();
    });
    socket.on(SocketEvents.STEP_COMPLETED, (p: { workflowRunId?: string; label: string }) => {
      if (!isActiveWorkflowRun(p.workflowRunId)) return;
      storeRef.current.setLastStep(p.label);
    });
    socket.on(
      SocketEvents.SCREENSHOT_FRAME,
      (p: { workflowRunId?: string; imageBase64: string }) => {
        if (!isActiveWorkflowRun(p.workflowRunId)) return;
        storeRef.current.setFrame(p.imageBase64);
      },
    );
    socket.on(
      SocketEvents.LOG_LINE,
      (p: { workflowRunId?: string; level: string; message: string; ts: string }) => {
        if (!isActiveWorkflowRun(p.workflowRunId)) return;
        storeRef.current.pushLog(p);
        const m = p.message.toLowerCase();
        if (
          m.includes("gdms dashboard is ready") ||
          m.includes("home screen detected") ||
          m.includes("gdms home screen detected")
        ) {
          const uid = useAuthStore.getState().user?.id;
          if (uid) useAutomationSessionStore.getState().markGdmsReady(uid);
        }
      },
    );
    socket.on(SocketEvents.WORKFLOW_FAILED, (p: { workflowRunId?: string; error?: string }) => {
      if (!isActiveWorkflowRun(p.workflowRunId)) return;
      const msg = typeof p?.error === "string" ? p.error : JSON.stringify(p);
      storeRef.current.pushLog({
        level: "error",
        message: `Workflow failed: ${msg}`,
        ts: new Date().toISOString(),
      });
    });
    socket.on(
      SocketEvents.WORKFLOW_PAUSED_USER,
      (p: { workflowRunId?: string; message?: string }) => {
        if (!isActiveWorkflowRun(p.workflowRunId)) return;
        const msg =
          typeof p?.message === "string" && p.message.trim()
            ? p.message
            : "Automation paused — fix CRM in the visible browser, then use Retry transfer.";
        storeRef.current.pushLog({
          level: "warn",
          message: `Paused for manual intervention: ${msg}`,
          ts: new Date().toISOString(),
        });
      },
    );
    socket.on(
      SocketEvents.CONTROL_ACK,
      (p: { workflowRunId?: string; action?: string; ok?: boolean }) => {
        if (!isActiveWorkflowRun(p?.workflowRunId)) return;
        if (p?.ok && p.action) {
          const actionLabel =
            p.action === "pause" ? "Pause" : p.action === "resume" ? "Resume" : "Stop";
          storeRef.current.pushLog({
            level: "info",
            message: `${actionLabel} confirmed by server.`,
            ts: new Date().toISOString(),
          });
        }
      },
    );
    socket.on(SocketEvents.WORKFLOW_COMPLETED, (p: { workflowRunId?: string }) => {
      if (isActiveWorkflowRun(p.workflowRunId)) {
        storeRef.current.setWorkflowDone(true);
        storeRef.current.pushLog({
          level: "info",
          message: "Workflow complete — the post-login GDMS screen should appear in the preview.",
          ts: new Date().toISOString(),
        });
      }
    });
    socket.on(
      SocketEvents.GDMS_SESSION_REDIRECTED,
      (p: { workflowRunId?: string; reason?: "timeout" | "logout" }) => {
        if (isActiveWorkflowRun(p.workflowRunId)) {
          const message =
            p.reason === "logout"
              ? "GDMS logout — login page should appear in the preview."
              : "GDMS session timed out — login page opened in the preview.";
          storeRef.current.pushLog({
            level: "info",
            message,
            ts: new Date().toISOString(),
          });
        }
      },
    );
    socket.on(SocketEvents.LEAD_CLASSIFIED, () => {
      const q = inquiriesSuffixRef.current;
      void fetch(`${getApiUrl()}/v1/inquiries${q}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      })
        .then((r) => r.json())
        .then((data: unknown) => {
          if (Array.isArray(data)) setRows(data as never[]);
          else if (data && typeof data === "object" && "items" in data) {
            setRows((data as { items: never[] }).items);
          }
        })
        .catch(() => {});
    });

    socket.on(SocketEvents.CALL_STATUS_UPDATE, (p: { inquiryId: string; phase: string }) => {
      setCallPhase(p.inquiryId, p.phase);
    });

    socket.on("connect", () => {
      storeRef.current.setRealtimeConnected(true);
      const id = useLiveStore.getState().runId;
      if (id) socket.emit("join_run", id);
    });

    socket.on("disconnect", () => {
      storeRef.current.setRealtimeConnected(false);
    });

    socket.on("connect_error", (err: Error) => {
      storeRef.current.setRealtimeConnected(false);
      const now = Date.now();
      if (now - lastSocketErrorLogAtRef.current < 30_000) return;
      lastSocketErrorLogAtRef.current = now;
      const origin =
        typeof window !== "undefined" ? window.location.origin : "app";
      if (useLiveStore.getState().runId) {
        storeRef.current.pushLog({
          level: "error",
          message: `Live updates disconnected (${err.message}). Check API on port 4000 is running (${origin} → ${getApiUrl()}). Automation may still run in the GDMS browser window.`,
          ts: new Date().toISOString(),
        });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      useLiveStore.getState().setRealtimeConnected(false);
    };
  }, [token, setRows, setCallPhase, setWorkflowDone]);

  useEffect(() => {
    const s = socketRef.current;
    if (s?.connected && runId) s.emit("join_run", runId);
  }, [runId]);
}

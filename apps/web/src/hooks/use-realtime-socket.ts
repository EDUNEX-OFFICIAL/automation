"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";
import { useLeadsStore } from "@/stores/leads-store";
import { SocketEvents } from "@gdms/shared";
import { getApiUrl, getSocketIoSettings } from "@/lib/api";
import { useAutomationSessionStore } from "@/stores/automation-session-store";

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
      storeRef.current.openOtp(p.workflowRunId);
    });
    socket.on(SocketEvents.STEP_COMPLETED, (p: { label: string }) => {
      storeRef.current.setLastStep(p.label);
    });
    socket.on(SocketEvents.SCREENSHOT_FRAME, (p: { imageBase64: string }) => {
      storeRef.current.setFrame(p.imageBase64);
    });
    socket.on(SocketEvents.LOG_LINE, (p: { level: string; message: string; ts: string }) => {
      storeRef.current.pushLog(p);
      const m = p.message.toLowerCase();
      if (
        m.includes("gdms dashboard is ready") ||
        m.includes("home screen detected") ||
        m.includes("gdms home screen detected")
      ) {
        const dealerId = useAuthStore.getState().user?.dealerId;
        if (dealerId) useAutomationSessionStore.getState().markGdmsReady(dealerId);
      }
    });
    socket.on(SocketEvents.WORKFLOW_FAILED, (p: { error?: string }) => {
      const msg = typeof p?.error === "string" ? p.error : JSON.stringify(p);
      storeRef.current.pushLog({
        level: "error",
        message: `Workflow failed: ${msg}`,
        ts: new Date().toISOString(),
      });
    });
    socket.on(SocketEvents.WORKFLOW_PAUSED_USER, (p: { message?: string }) => {
      const msg =
        typeof p?.message === "string" && p.message.trim()
          ? p.message
          : "Automation paused — fix CRM in the visible browser, then use Retry transfer.";
      storeRef.current.pushLog({
        level: "warn",
        message: `Paused for manual intervention: ${msg}`,
        ts: new Date().toISOString(),
      });
    });
    socket.on(SocketEvents.WORKFLOW_COMPLETED, (p: { workflowRunId?: string }) => {
      if (p?.workflowRunId && p.workflowRunId === useLiveStore.getState().runId) {
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
        if (p?.workflowRunId && p.workflowRunId === useLiveStore.getState().runId) {
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
        .then((data: unknown) => setRows(data as never[]))
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
      storeRef.current.pushLog({
        level: "error",
        message: `Live updates disconnected (${err.message}). Check API on port 4000 is running (${origin} → ${getApiUrl()}). Automation may still run in the GDMS browser window.`,
        ts: new Date().toISOString(),
      });
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

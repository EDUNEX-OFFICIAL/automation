"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";
import { useLeadsStore } from "@/stores/leads-store";
import { SocketEvents } from "@gdms/shared";
import { getApiUrl, getSocketIoSettings } from "@/lib/api";

export function useRealtimeSocket(): void {
  const token = useAuthStore((s) => s.accessToken);
  const runId = useLiveStore((s) => s.runId);
  const socketRef = useRef<Socket | null>(null);
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
    /** Separate origin (Next :3001 → API :4000): many embedded browsers block WS cross-port — stick to HTTP long-polling */
    const directHttpSocket =
      typeof process.env.NEXT_PUBLIC_SOCKET_URL === "string" &&
      /^https?:\/\//i.test(process.env.NEXT_PUBLIC_SOCKET_URL);
    const transports = directHttpSocket
      ? (["polling"] as const)
      : (["polling", "websocket"] as const);

    const socket = io(uri, {
      ...(path ? { path } : {}),
      auth: { token },
      transports: [...transports],
      /** Avoid WS upgrade when only polling works (Cursor preview, corp proxies) */
      ...(directHttpSocket ? { upgrade: false } : {}),
      withCredentials: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 25,
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
    });
    socket.on(SocketEvents.WORKFLOW_FAILED, (p: { error?: string }) => {
      const msg = typeof p?.error === "string" ? p.error : JSON.stringify(p);
      storeRef.current.pushLog({
        level: "error",
        message: `Workflow failed: ${msg}`,
        ts: new Date().toISOString(),
      });
    });
    socket.on(SocketEvents.WORKFLOW_COMPLETED, (p: { workflowRunId?: string }) => {
      if (p?.workflowRunId && p.workflowRunId === useLiveStore.getState().runId) {
        storeRef.current.setWorkflowDone(true);
        storeRef.current.pushLog({
          level: "info",
          message: "Workflow complete — GDMS me post-login screen preview me dikhna chahiye.",
          ts: new Date().toISOString(),
        });
      }
    });
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
      storeRef.current.pushLog({
        level: "error",
        message: `Socket: ${err.message} — polling-only mode (WS off) for :3001→:4000; phir bhi fail ho to Chrome + API :4000 verify karo`,
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

import { create } from "zustand";
import { RUN_LOG_BUFFER_MAX_LINES } from "@gdms/shared";
import { userFacingLogMessage } from "@/lib/automation-log-user";

function toFriendlyLog(l: { level: string; message: string; ts: string }): {
  level: string;
  message: string;
  ts: string;
} {
  return { ...l, message: userFacingLogMessage(l.message) };
}

const MAX_UI_LOG_LINES = RUN_LOG_BUFFER_MAX_LINES;

function logDedupeKey(l: { level: string; message: string }): string {
  return `${l.level}|${l.message}`;
}

function shouldSkipDuplicateLog(
  last: { level: string; message: string; ts: string } | undefined,
  next: { level: string; message: string; ts: string },
): boolean {
  if (!last) return false;
  if (logDedupeKey(last) !== logDedupeKey(next)) return false;
  const gap = Math.abs(new Date(next.ts).getTime() - new Date(last.ts).getTime());
  const repeatFriendly =
    /search|enquir|list|poll|refresh|lead tab|no match|trying again/i.test(next.message);
  return repeatFriendly ? gap < 25_000 : gap < 4000;
}

type LiveState = {
  runId: string | null;
  frameBase64: string | null;
  lastStep: string | null;
  logs: { level: string; message: string; ts: string }[];
  realtimeConnected: boolean;
  otpOpen: boolean;
  otpRunId: string | null;
  /** Stays true from OTP_REQUIRED until submit, cancel, or run ends — avoids accidental modal dismiss. */
  otpPending: boolean;
  /** True when SOCKET says this run finished successfully (login etc.). */
  workflowDone: boolean;
  setRun: (runId: string | null) => void;
  setFrame: (b64: string | null) => void;
  pushLog: (l: { level: string; message: string; ts: string }) => void;
  setLastStep: (s: string | null) => void;
  setRealtimeConnected: (v: boolean) => void;
  setWorkflowDone: (v: boolean) => void;
  openOtp: (runId: string) => void;
  closeOtp: () => void;
  resetLogs: () => void;
  /** Clear on-screen log; ignore poll replay until new lines arrive after clear. */
  clearLogs: () => void;
  logsClearedAt: number | null;
  /** Merge logs from API poll (Redis buffer) without duplicating socket lines. */
  mergeLogsFromPoll: (lines: { level: string; message: string; ts: string }[]) => void;
};

export const useLiveStore = create<LiveState>((set) => ({
  runId: null,
  frameBase64: null,
  lastStep: null,
  logs: [],
  realtimeConnected: false,
  otpOpen: false,
  otpRunId: null,
  otpPending: false,
  workflowDone: false,
  logsClearedAt: null,
  setRun: (runId) => set({ runId, workflowDone: false, logsClearedAt: null }),
  setFrame: (frameBase64) => set({ frameBase64 }),
  pushLog: (l) =>
    set((s) => {
      const friendly = toFriendlyLog(l);
      const last = s.logs[s.logs.length - 1];
      if (shouldSkipDuplicateLog(last, friendly)) return s;
      return { logs: [...s.logs, friendly].slice(-MAX_UI_LOG_LINES) };
    }),
  setLastStep: (lastStep) => set({ lastStep }),
  setRealtimeConnected: (realtimeConnected) => set({ realtimeConnected }),
  setWorkflowDone: (workflowDone) => set({ workflowDone }),
  openOtp: (otpRunId) => set({ otpOpen: true, otpRunId, otpPending: true }),
  closeOtp: () => set({ otpOpen: false, otpRunId: null, otpPending: false }),
  resetLogs: () => set({ logs: [], logsClearedAt: null }),
  clearLogs: () => set({ logs: [], logsClearedAt: Date.now() }),
  mergeLogsFromPoll: (lines) =>
    set((s) => {
      if (lines.length === 0) return s;
      const cutoff = s.logsClearedAt;
      const incoming = (cutoff
        ? lines.filter((l) => new Date(l.ts).getTime() > cutoff)
        : lines
      ).map(toFriendlyLog);
      if (incoming.length === 0) return s;
      const seen = new Set(s.logs.map((l) => `${l.ts}|${l.level}|${l.message}`));
      const merged = [...s.logs];
      for (const l of incoming) {
        const key = `${l.ts}|${l.level}|${l.message}`;
        if (seen.has(key)) continue;
        const prev = merged[merged.length - 1];
        if (shouldSkipDuplicateLog(prev, l)) continue;
        seen.add(key);
        merged.push(l);
      }
      merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      return { logs: merged.slice(-MAX_UI_LOG_LINES) };
    }),
}));

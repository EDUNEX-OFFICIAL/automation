import { create } from "zustand";

type LiveState = {
  runId: string | null;
  frameBase64: string | null;
  lastStep: string | null;
  logs: { level: string; message: string; ts: string }[];
  realtimeConnected: boolean;
  otpOpen: boolean;
  otpRunId: string | null;
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
  workflowDone: false,
  setRun: (runId) => set({ runId, workflowDone: false }),
  setFrame: (frameBase64) => set({ frameBase64 }),
  pushLog: (l) =>
    set((s) => {
      const last = s.logs[s.logs.length - 1];
      if (
        last &&
        last.message === l.message &&
        last.level === l.level &&
        Math.abs(new Date(l.ts).getTime() - new Date(last.ts).getTime()) < 4000
      ) {
        return s;
      }
      return { logs: [...s.logs, l].slice(-200) };
    }),
  setLastStep: (lastStep) => set({ lastStep }),
  setRealtimeConnected: (realtimeConnected) => set({ realtimeConnected }),
  setWorkflowDone: (workflowDone) => set({ workflowDone }),
  openOtp: (otpRunId) => set({ otpOpen: true, otpRunId }),
  closeOtp: () => set({ otpOpen: false, otpRunId: null }),
  resetLogs: () => set({ logs: [] }),
  mergeLogsFromPoll: (lines) =>
    set((s) => {
      if (lines.length === 0) return s;
      const seen = new Set(s.logs.map((l) => `${l.ts}|${l.level}|${l.message}`));
      const merged = [...s.logs];
      for (const l of lines) {
        const key = `${l.ts}|${l.level}|${l.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(l);
      }
      merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      return { logs: merged.slice(-200) };
    }),
}));

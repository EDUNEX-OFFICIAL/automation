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
  pushLog: (l) => set((s) => ({ logs: [...s.logs, l].slice(-200) })),
  setLastStep: (lastStep) => set({ lastStep }),
  setRealtimeConnected: (realtimeConnected) => set({ realtimeConnected }),
  setWorkflowDone: (workflowDone) => set({ workflowDone }),
  openOtp: (otpRunId) => set({ otpOpen: true, otpRunId }),
  closeOtp: () => set({ otpOpen: false, otpRunId: null }),
  resetLogs: () => set({ logs: [] }),
}));

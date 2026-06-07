import { create } from "zustand";
import { RUN_LOG_BUFFER_MAX_LINES } from "@gdms/shared";
import { userFacingLogMessage } from "@/lib/automation-log-user";

function toFriendlyLog(l: { level: string; message: string; ts: string }): {
  level: string;
  message: string;
  ts: string;
} | null {
  const message = userFacingLogMessage(l.message);
  if (!message) return null;
  return { ...l, message };
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
    /search|enquir|list|poll|refresh|lead tab|no match|trying again|basic info|pin lookup|follow-up|follow up|saving/i.test(
      next.message,
    );
  return repeatFriendly ? gap < 25_000 : true;
}

type LogLine = { level: string; message: string; ts: string };

function appendLogLine(existing: LogLine[], next: LogLine): LogLine[] {
  const last = existing[existing.length - 1];
  if (shouldSkipDuplicateLog(last, next)) return existing;
  return [...existing, next].slice(-MAX_UI_LOG_LINES);
}

type LiveState = {
  runId: string | null;
  frameBase64: string | null;
  lastStep: string | null;
  logs: LogLine[];
  /** Per-run log buffers for multi-tab Live session. */
  logsByRunId: Record<string, LogLine[]>;
  realtimeConnected: boolean;
  otpOpen: boolean;
  otpRunId: string | null;
  /** Stays true from OTP_REQUIRED until submit, cancel, or run ends — avoids accidental modal dismiss. */
  otpPending: boolean;
  /** True when SOCKET says this run finished successfully (login etc.). */
  workflowDone: boolean;
  /** Run IDs subscribed on the realtime socket (multi-tab Live session). */
  watchedRunIds: string[];
  setWatchedRunIds: (ids: string[]) => void;
  setRun: (runId: string | null) => void;
  setFrame: (b64: string | null) => void;
  pushLog: (l: LogLine) => void;
  pushLogForRun: (runId: string, l: LogLine) => void;
  getLogsForRun: (runId: string) => LogLine[];
  setLastStep: (s: string | null) => void;
  setRealtimeConnected: (v: boolean) => void;
  setWorkflowDone: (v: boolean) => void;
  openOtp: (runId: string) => void;
  closeOtp: () => void;
  resetLogs: () => void;
  /** Clear on-screen log; ignore poll replay until new lines arrive after clear. */
  clearLogs: () => void;
  clearLogsForRun: (runId: string) => void;
  logsClearedAt: number | null;
  logsClearedAtByRunId: Record<string, number>;
  /** Merge logs from API poll (Redis buffer) without duplicating socket lines. */
  mergeLogsFromPoll: (lines: LogLine[], runId?: string) => void;
};

export const useLiveStore = create<LiveState>((set, get) => ({
  runId: null,
  frameBase64: null,
  lastStep: null,
  logs: [],
  logsByRunId: {},
  realtimeConnected: false,
  otpOpen: false,
  otpRunId: null,
  otpPending: false,
  workflowDone: false,
  logsClearedAt: null,
  logsClearedAtByRunId: {},
  watchedRunIds: [],
  setWatchedRunIds: (watchedRunIds) => set({ watchedRunIds }),
  setRun: (runId) => set({ runId, workflowDone: false, logsClearedAt: null }),
  setFrame: (frameBase64) => set({ frameBase64 }),
  pushLog: (l) =>
    set((s) => {
      const friendly = toFriendlyLog(l);
      if (!friendly) return s;
      const runId = s.runId;
      const logs = appendLogLine(s.logs, friendly);
      const next: Partial<LiveState> = { logs };
      if (runId) {
        const perRun = s.logsByRunId[runId] ?? [];
        next.logsByRunId = { ...s.logsByRunId, [runId]: appendLogLine(perRun, friendly) };
      }
      return next as LiveState;
    }),
  pushLogForRun: (runId, l) =>
    set((s) => {
      const friendly = toFriendlyLog(l);
      if (!friendly) return s;
      const perRun = s.logsByRunId[runId] ?? [];
      const merged = appendLogLine(perRun, friendly);
      const next: Partial<LiveState> = {
        logsByRunId: { ...s.logsByRunId, [runId]: merged },
      };
      if (s.runId === runId) {
        next.logs = appendLogLine(s.logs, friendly);
      }
      return next as LiveState;
    }),
  getLogsForRun: (runId) => get().logsByRunId[runId] ?? [],
  setLastStep: (lastStep) => set({ lastStep }),
  setRealtimeConnected: (realtimeConnected) => set({ realtimeConnected }),
  setWorkflowDone: (workflowDone) => set({ workflowDone }),
  openOtp: (otpRunId) => set({ otpOpen: true, otpRunId, otpPending: true }),
  closeOtp: () => set({ otpOpen: false, otpRunId: null, otpPending: false }),
  resetLogs: () => set({ logs: [], logsClearedAt: null, logsByRunId: {}, logsClearedAtByRunId: {} }),
  clearLogs: () => set({ logs: [], logsClearedAt: Date.now() }),
  clearLogsForRun: (runId) =>
    set((s) => ({
      logsByRunId: { ...s.logsByRunId, [runId]: [] },
      logsClearedAtByRunId: { ...s.logsClearedAtByRunId, [runId]: Date.now() },
      logs: s.runId === runId ? [] : s.logs,
      logsClearedAt: s.runId === runId ? Date.now() : s.logsClearedAt,
    })),
  mergeLogsFromPoll: (lines, runId) =>
    set((s) => {
      if (lines.length === 0) return s;
      const cutoff = runId ? s.logsClearedAtByRunId[runId] : s.logsClearedAt;
      const incoming = (cutoff
        ? lines.filter((l) => new Date(l.ts).getTime() > cutoff)
        : lines
      )
        .map(toFriendlyLog)
        .filter((l): l is LogLine => l !== null);
      if (incoming.length === 0) return s;

      const mergeInto = (existing: LogLine[]): LogLine[] => {
        const seen = new Set(existing.map((l) => `${l.ts}|${l.level}|${l.message}`));
        const merged = [...existing];
        for (const l of incoming) {
          const key = `${l.ts}|${l.level}|${l.message}`;
          if (seen.has(key)) continue;
          const prev = merged[merged.length - 1];
          if (shouldSkipDuplicateLog(prev, l)) continue;
          seen.add(key);
          merged.push(l);
        }
        merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        return merged.slice(-MAX_UI_LOG_LINES);
      };

      const next: Partial<LiveState> = {};
      if (runId) {
        const perRun = mergeInto(s.logsByRunId[runId] ?? []);
        next.logsByRunId = { ...s.logsByRunId, [runId]: perRun };
        if (s.runId === runId) next.logs = perRun;
      } else {
        next.logs = mergeInto(s.logs);
      }
      return next as LiveState;
    }),
}));

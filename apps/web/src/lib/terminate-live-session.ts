import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

export const TERMINAL_RUN_STATUSES = new Set(["STOPPED", "COMPLETED"]);

/** Clears linked run + saved session so refresh does not resurrect a finished job. */
export function terminateLiveSessionLocally(userId: string | null | undefined): void {
  const otpPending = useLiveStore.getState().otpPending;
  if (userId) useAutomationSessionStore.getState().clear(userId);
  useLiveStore.getState().setRun(null);
  useLiveStore.getState().setFrame(null);
  useLiveStore.getState().setWorkflowDone(false);
  if (!otpPending) useLiveStore.getState().closeOtp();
}

export function clearLiveStoreOnly(): void {
  useLiveStore.getState().setRun(null);
  useLiveStore.getState().setFrame(null);
  useLiveStore.getState().setWorkflowDone(false);
  useLiveStore.getState().closeOtp();
  useLiveStore.getState().resetLogs();
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_RUN_STATUSES.has(status));
}

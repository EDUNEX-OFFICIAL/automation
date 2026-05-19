import { useAutomationSessionStore } from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

export const TERMINAL_RUN_STATUSES = new Set(["STOPPED", "COMPLETED"]);

/** Clears linked run + saved session so refresh does not resurrect a finished job. */
export function terminateLiveSessionLocally(dealerId: string | null | undefined): void {
  if (dealerId) useAutomationSessionStore.getState().clear(dealerId);
  useLiveStore.getState().setRun(null);
  useLiveStore.getState().setFrame(null);
  useLiveStore.getState().setWorkflowDone(false);
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return Boolean(status && TERMINAL_RUN_STATUSES.has(status));
}

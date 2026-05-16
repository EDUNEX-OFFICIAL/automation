import type { AutomationOperation, AutomationSource, SubSourcesSelection } from "@gdms/shared";
import { apiFetch } from "@/lib/api";
import {
  useAutomationSessionStore,
  type SavedAutomationSession,
} from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

export function persistAutomationRun(input: {
  runId: string;
  dealerId: string;
  operation: AutomationOperation;
  sources: AutomationSource[];
  subSources?: SubSourcesSelection;
}): void {
  useAutomationSessionStore.getState().save({
    runId: input.runId,
    dealerId: input.dealerId,
    operation: input.operation,
    sources: input.sources,
    subSources: input.subSources,
  });
  useLiveStore.getState().setRun(input.runId);
}

export async function resumeSavedAutomationSession(
  token: string,
  saved: SavedAutomationSession,
): Promise<void> {
  persistAutomationRun({
    runId: saved.runId,
    dealerId: saved.dealerId,
    operation: saved.operation,
    sources: saved.sources,
    subSources: saved.subSources,
  });

  const [run, session] = await Promise.all([
    apiFetch<{ status: string }>(`/v1/workflow-runs/${saved.runId}`, { token }),
    apiFetch<{ active: boolean }>(`/v1/workflow-runs/${saved.runId}/session-active`, { token }),
  ]);

  const resumableStatus =
    run.status === "FAILED" ||
    run.status === "PAUSED_USER" ||
    run.status === "RUNNING" ||
    run.status === "PAUSED_OTP" ||
    run.status === "STOPPED";

  if (!resumableStatus || saved.operation !== "enquiry_transfer") {
    return;
  }

  if (session.active) {
    await apiFetch(`/v1/workflow-runs/${saved.runId}/retry-transfer`, {
      method: "POST",
      token,
      body: JSON.stringify({}),
    });
    return;
  }

  await apiFetch(`/v1/workflow-runs/${saved.runId}/resume-session`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

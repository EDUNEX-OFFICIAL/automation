import type { AutomationOperation, AutomationSource, SubSourcesSelection } from "@gdms/shared";
import { apiFetch } from "@/lib/api";
import {
  useAutomationSessionStore,
  type SavedAutomationSession,
} from "@/stores/automation-session-store";
import { useLiveStore } from "@/stores/live-store";

const IN_FLIGHT_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "PAUSED_OTP",
  "PAUSED_USER",
  "FAILED",
]);

type WorkflowRunSummary = { id: string; status: string; dealerId?: string };

/** Link Live session to the current automation run (works for super admin without dealerId on JWT). */
export async function findInFlightWorkflowRunId(token: string): Promise<string | null> {
  const liveRunId = useLiveStore.getState().runId;
  if (liveRunId) return liveRunId;

  const byDealer = useAutomationSessionStore.getState().byDealer;
  for (const saved of Object.values(byDealer)) {
    if (!saved?.runId) continue;
    try {
      const run = await apiFetch<{ status: string }>(`/v1/workflow-runs/${saved.runId}`, { token });
      if (IN_FLIGHT_STATUSES.has(run.status)) return saved.runId;
    } catch {
      /* stale saved id */
    }
  }

  const res = await apiFetch<{ run: WorkflowRunSummary | null }>(`/v1/workflow-runs/in-flight`, {
    token,
  });
  return res.run?.id ?? null;
}

export async function linkLiveSessionToInFlightRun(token: string): Promise<string | null> {
  const id = await findInFlightWorkflowRunId(token);
  if (id) useLiveStore.getState().setRun(id);
  return id;
}

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

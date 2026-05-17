import {
  automationRunParamsSchema,
  type AutomationOperation,
  type AutomationSource,
  type SubSourcesSelection,
} from "@gdms/shared";
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

export type WorkflowRunDetail = {
  id: string;
  dealerId: string;
  status: string;
  runParams: unknown;
  errorMessage?: string | null;
};

const RESUMABLE_STATUSES = new Set([
  "FAILED",
  "PAUSED_USER",
  "RUNNING",
  "PAUSED_OTP",
  "STOPPED",
]);

function normalizeRunIdInput(raw: string): string {
  return raw.trim();
}

/** Load dealer + automation options from an existing workflow run (session / run ID). */
export async function loadSessionByRunId(
  token: string,
  runIdInput: string,
): Promise<SavedAutomationSession> {
  const runId = normalizeRunIdInput(runIdInput);
  if (!runId) {
    throw new Error("Enter a session ID (workflow run ID from Live session or your saved run).");
  }

  const run = await apiFetch<WorkflowRunDetail>(`/v1/workflow-runs/${encodeURIComponent(runId)}`, {
    token,
  });

  const params = automationRunParamsSchema.safeParse(run.runParams);
  if (!params.success) {
    throw new Error(
      "This session does not have valid enquiry transfer settings. Start a new run from the form instead.",
    );
  }

  return {
    runId: run.id,
    dealerId: run.dealerId,
    operation: params.data.operation,
    sources: params.data.sources,
    subSources: params.data.subSources,
    savedAt: Date.now(),
    otpVerifiedAt: run.status !== "PENDING" ? Date.now() : undefined,
    gdmsReadyAt: ["RUNNING", "PAUSED_USER", "COMPLETED", "FAILED", "STOPPED"].includes(run.status)
      ? Date.now()
      : undefined,
  };
}

/** Persist session locally, resume browser profile / transfer on automation-service. */
export async function startAutomationFromSessionId(
  token: string,
  runIdInput: string,
): Promise<SavedAutomationSession> {
  const saved = await loadSessionByRunId(token, runIdInput);
  useAutomationSessionStore.getState().save(saved);
  await resumeSavedAutomationSession(token, saved);
  return saved;
}

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

  if (saved.operation !== "enquiry_transfer") {
    throw new Error("Only enquiry transfer sessions can be started from a session ID.");
  }

  if (run.status === "COMPLETED") {
    throw new Error("This session has already completed. Use START to begin a new run.");
  }

  if (!RESUMABLE_STATUSES.has(run.status)) {
    throw new Error(
      `This session cannot be resumed (status: ${run.status}). Try START for a new run.`,
    );
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

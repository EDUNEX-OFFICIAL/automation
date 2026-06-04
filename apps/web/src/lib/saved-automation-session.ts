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
import { useAuthStore } from "@/stores/auth-store";
import { useLiveStore } from "@/stores/live-store";

const IN_FLIGHT_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "PAUSED_OTP",
  "PAUSED_USER",
]);

type WorkflowRunSummary = { id: string; status: string; dealerId?: string; startedByUserId?: string | null };

export type WorkflowRunDetail = {
  id: string;
  dealerId: string;
  status: string;
  runParams: unknown;
  startedByUserId?: string | null;
  errorMessage?: string | null;
};

const RESUMABLE_STATUSES = new Set(["FAILED", "PAUSED_USER", "RUNNING", "PAUSED_OTP"]);

function normalizeRunIdInput(raw: string): string {
  return raw.trim();
}

function currentUserId(): string {
  const id = useAuthStore.getState().user?.id;
  if (!id) throw new Error("Not signed in");
  return id;
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
      "This session does not have valid automation settings. Start a new enquiry transfer from the dashboard instead.",
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
  useAutomationSessionStore.getState().save(currentUserId(), saved);
  await resumeSavedAutomationSession(token, saved);
  return saved;
}

/** Link Live session to this user's in-flight run only. */
export async function findInFlightWorkflowRunId(
  token: string,
  userId: string,
): Promise<string | null> {
  const liveRunId = useLiveStore.getState().runId;
  if (liveRunId) {
    try {
      const run = await apiFetch<{ status: string }>(`/v1/workflow-runs/${liveRunId}`, { token });
      if (IN_FLIGHT_STATUSES.has(run.status)) return liveRunId;
    } catch {
      useLiveStore.getState().setRun(null);
    }
  }

  const saved = useAutomationSessionStore.getState().get(userId);
  if (saved?.runId) {
    try {
      const run = await apiFetch<{ status: string }>(`/v1/workflow-runs/${saved.runId}`, { token });
      if (IN_FLIGHT_STATUSES.has(run.status)) return saved.runId;
    } catch {
      useAutomationSessionStore.getState().clear(userId);
    }
  }

  const res = await apiFetch<{ run: WorkflowRunSummary | null }>(`/v1/workflow-runs/in-flight`, {
    token,
  });
  const id = res.run?.id ?? null;
  if (id && res.run?.startedByUserId && res.run.startedByUserId !== userId) {
    return null;
  }
  return id;
}

export async function linkLiveSessionToInFlightRun(
  token: string,
  userId: string,
): Promise<string | null> {
  const id = await findInFlightWorkflowRunId(token, userId);
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
  const userId = currentUserId();
  useAutomationSessionStore.getState().save(userId, {
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

  const resumePath =
    saved.operation === "follow_up_skip"
      ? "resume-session"
      : saved.operation === "enquiry_transfer"
        ? "resume-session"
        : null;
  if (!resumePath) {
    throw new Error("This operation cannot be resumed from a session ID.");
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

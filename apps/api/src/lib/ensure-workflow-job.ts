import type { WorkflowRun } from "@gdms/database";
import { automationRunParamsSchema, type WorkflowJobData } from "@gdms/shared";
import { workflowQueue } from "../queue.js";

export type EnsureWorkflowJobResult =
  | { ok: true; jobState: string; alreadyQueued?: boolean }
  | { ok: false; reason: string };

const BULL_WAIT_KEY = "bull:workflow:wait";

/** Removes failed/completed Bull jobs so the same jobId can be enqueued again. */
export async function removeStaleBullJob(runId: string): Promise<void> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (!job) return;
    const state = await job.getState();
    if (state === "failed" || state === "completed") {
      await job.remove();
    }
  } catch {
    /* ignore redis errors */
  }
}

/** Drops job hash and any orphan wait-list entry so jobId can be enqueued cleanly. */
export async function purgeBullJobArtifacts(runId: string): Promise<void> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (job) await job.remove();
  } catch {
    /* ignore */
  }
  try {
    const client = await workflowQueue.client;
    await client.lrem(BULL_WAIT_KEY, 0, runId);
  } catch {
    /* ignore */
  }
}

export type EnsureWorkflowJobOptions = {
  /** User retry or heal: remove stuck/orphan queue entries before enqueue. */
  force?: boolean;
};

const STUCK_WAITING_MS = 45_000;

export async function isBullJobStillQueued(runId: string): Promise<boolean> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    if (state === "active") return true;
    if (state === "waiting" || state === "delayed") {
      const ageMs = Date.now() - (job.timestamp ?? 0);
      if (ageMs > STUCK_WAITING_MS) return false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Waiting in Redis longer than the worker should need — safe to purge and re-enqueue. */
export async function isBullJobStuckWaiting(runId: string): Promise<boolean> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed") return false;
    return Date.now() - (job.timestamp ?? 0) > STUCK_WAITING_MS;
  } catch {
    return false;
  }
}

/** True when Redis wait list still references a job id BullMQ cannot load (stuck PENDING). */
export async function isBullWaitListOrphan(runId: string): Promise<boolean> {
  if (await workflowQueue.getJob(runId)) return false;
  try {
    const client = await workflowQueue.client;
    const ids = await client.lrange(BULL_WAIT_KEY, 0, -1);
    return ids.includes(runId);
  } catch {
    return false;
  }
}

function jobDataFromRun(
  run: Pick<WorkflowRun, "id" | "dealerId" | "runParams" | "startedByUserId">,
): WorkflowJobData | null {
  const parsed = automationRunParamsSchema.safeParse(run.runParams);
  if (!parsed.success || !run.startedByUserId) return null;
  const { operation, sources, subSources } = parsed.data;
  return {
    runId: run.id,
    dealerId: run.dealerId,
    startedByUserId: run.startedByUserId,
    operation,
    sources,
    ...(subSources ? { subSources } : {}),
  };
}

export async function ensureWorkflowJobQueued(
  run: Pick<WorkflowRun, "id" | "dealerId" | "runParams" | "startedByUserId">,
  options?: EnsureWorkflowJobOptions,
): Promise<EnsureWorkflowJobResult> {
  const force = options?.force === true;
  const orphanWait = await isBullWaitListOrphan(run.id);

  const stuckWaiting = await isBullJobStuckWaiting(run.id);

  if (force || orphanWait || stuckWaiting) {
    await purgeBullJobArtifacts(run.id);
  } else if (await isBullJobStillQueued(run.id)) {
    const job = await workflowQueue.getJob(run.id);
    const jobState = job ? await job.getState() : "unknown";
    return { ok: true, jobState, alreadyQueued: true };
  }

  const jobData = jobDataFromRun(run);
  if (!jobData) {
    return { ok: false, reason: "Run has no valid saved automation options." };
  }

  await removeStaleBullJob(run.id);

  try {
    await workflowQueue.add("execute", jobData, {
      jobId: run.id,
      attempts: 5,
      backoff: { type: "exponential", delay: 3000 },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }

  const job = await workflowQueue.getJob(run.id);
  if (!job) {
    return { ok: false, reason: "Job missing after enqueue" };
  }
  const jobState = await job.getState();
  return { ok: true, jobState };
}

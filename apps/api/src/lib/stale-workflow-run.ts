import type { WorkflowRun, WorkflowRunStatus } from "@gdms/database";
import { prisma } from "../prisma.js";
import { workflowQueue } from "../queue.js";
import { isWatchdogActive } from "../redis.js";
import { env } from "../config.js";
import {
  ensureWorkflowJobQueued,
  isBullJobStillQueued,
  isBullJobStuckWaiting,
  isBullWaitListOrphan,
} from "./ensure-workflow-job.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

export const IN_FLIGHT_WORKFLOW_STATUSES: WorkflowRunStatus[] = [
  "PENDING",
  "RUNNING",
  "PAUSED_OTP",
];

/** Rows that block a new START unless cleared or still have a live browser. */
const BLOCKING_WORKFLOW_STATUSES: WorkflowRunStatus[] = [
  ...IN_FLIGHT_WORKFLOW_STATUSES,
  "PAUSED_USER",
  "FAILED",
];

const STALE_END_MESSAGE =
  "This run was still marked active in the database after the browser or automation service stopped (for example after restarting pnpm dev). It was cleared automatically — you can start a new run.";

async function fetchAutomationSessionActive(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`${automationBase()}/internal/session-active/${runId}`, {
      headers: { "x-internal-secret": automationSecret() },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { active?: boolean };
    return Boolean(data.active);
  } catch {
    return false;
  }
}

async function getBullJobState(runId: string): Promise<string | null> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (!job) return null;
    return job.getState();
  } catch {
    return null;
  }
}

async function workflowWorkerCount(): Promise<number> {
  try {
    const workers = await workflowQueue.getWorkers();
    return workers.length;
  } catch {
    return 0;
  }
}

const PENDING_GRACE_MS = 8_000;

/** Bull marks the workflow job completed as soon as automation accepts HTTP 202 — not when Playwright finishes. */
const RUNNING_SESSION_GRACE_MS = 30 * 60_000;

/** RUNNING enquiry transfer can run for hours; only reconcile-stale may end orphaned rows after this. */
const RUNNING_MAX_AGE_MS = 12 * 60 * 60_000;

const WATCHDOG_MAX_AGE_MS = 60_000;

const WORKER_NOT_PROCESSING_MESSAGE =
  "Automation worker did not pick up this run. On the server, ensure @gdms/worker and @gdms/automation-service are running and share the same REDIS_URL as the API.";

/** True when automation is actually executing or holding a live browser for this run. */
export async function isWorkflowRunLive(
  run: { id: string; status: WorkflowRunStatus; startedAt: Date },
): Promise<boolean> {
  if (await fetchAutomationSessionActive(run.id)) return true;
  if (await isWatchdogActive(run.id, WATCHDOG_MAX_AGE_MS)) return true;

  const ageMs = Date.now() - run.startedAt.getTime();

  if (run.status === "PENDING") {
    if (ageMs < PENDING_GRACE_MS) return true;
    const jobState = await getBullJobState(run.id);
    if (jobState === "active") return true;
    if ((jobState === "waiting" || jobState === "delayed") && ageMs < 45_000) {
      return true;
    }
    return false;
  }

  if (run.status === "PAUSED_OTP") {
    if (ageMs < 12 * 60 * 60_000) {
      return isBullJobStillQueued(run.id) || ageMs < 2 * 60_000;
    }
    return false;
  }

  if (run.status === "PAUSED_USER" || run.status === "FAILED") {
    return fetchAutomationSessionActive(run.id);
  }

  if (run.status === "RUNNING") {
    if (ageMs < RUNNING_SESSION_GRACE_MS) return true;
    if (ageMs < RUNNING_MAX_AGE_MS) {
      return fetchAutomationSessionActive(run.id);
    }
    return false;
  }

  return false;
}

export type ReconcileStaleResult = {
  clearedRunIds: string[];
  requeuedRunIds: string[];
};

/** Marks orphaned in-flight rows STOPPED so a new START is allowed. */
export async function reconcileStaleWorkflowRunsForDealer(dealerId: string): Promise<ReconcileStaleResult> {
  const inFlight = await prisma.workflowRun.findMany({
    where: {
      dealerId,
      status: { in: BLOCKING_WORKFLOW_STATUSES },
    },
    orderBy: { startedAt: "asc" },
  });

  const clearedRunIds: string[] = [];
  const requeuedRunIds: string[] = [];

  for (const run of inFlight) {
    if (run.status === "PAUSED_OTP") continue;
    if (await isWorkflowRunLive(run)) continue;

    if (run.status === "PENDING") {
      const result = await ensureWorkflowJobQueued(run, { force: true });
      if (result.ok) {
        requeuedRunIds.push(run.id);
        continue;
      }
    }

    let errorMessage = STALE_END_MESSAGE;
    let status: WorkflowRunStatus = "STOPPED";

    if (run.status === "PAUSED_USER" || run.status === "FAILED") {
      errorMessage =
        run.errorMessage?.trim() ||
        "This run was closed because the browser session ended. Start a new run from the Dashboard.";
    }

    if (run.status === "PENDING") {
      const jobState = await getBullJobState(run.id);
      if (jobState === "failed") {
        const job = await workflowQueue.getJob(run.id);
        const reason = job?.failedReason ? String(job.failedReason) : "";
        status = "FAILED";
        errorMessage = reason || WORKER_NOT_PROCESSING_MESSAGE;
      } else if ((await workflowWorkerCount()) === 0) {
        status = "FAILED";
        errorMessage = WORKER_NOT_PROCESSING_MESSAGE;
      }
    }

    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status,
        endedAt: new Date(),
        errorMessage,
      },
    });
    clearedRunIds.push(run.id);
  }

  return { clearedRunIds, requeuedRunIds };
}

const HEAL_ON_READ_STATUSES: WorkflowRunStatus[] = ["PENDING", "RUNNING", "PAUSED_OTP"];

/** Re-queue orphan PENDING runs or stop stale RUNNING rows when polled by Live session. */
export async function healWorkflowRunOnRead(run: WorkflowRun): Promise<WorkflowRun> {
  if (!HEAL_ON_READ_STATUSES.includes(run.status)) return run;
  if (run.status === "PAUSED_OTP") return run;
  if (await isWorkflowRunLive(run)) return run;

  if (run.status === "PENDING") {
    const ageMs = Date.now() - run.startedAt.getTime();
    if (ageMs < PENDING_GRACE_MS) return run;

    const orphan = await isBullWaitListOrphan(run.id);
    const stuck = await isBullJobStuckWaiting(run.id);
    if (orphan || stuck) {
      await ensureWorkflowJobQueued(run, { force: true });
    } else if (!(await isBullJobStillQueued(run.id))) {
      await ensureWorkflowJobQueued(run, { force: false });
    }
    return prisma.workflowRun.findUnique({ where: { id: run.id } }).then((r) => r ?? run);
  }

  // RUNNING rows are only cleared via POST reconcile-stale — never on Live session poll.
  return run;
}

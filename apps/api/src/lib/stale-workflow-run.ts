import type { WorkflowRunStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { workflowQueue } from "../queue.js";
import { isWatchdogActive } from "../redis.js";
import { env } from "../config.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

export const IN_FLIGHT_WORKFLOW_STATUSES: WorkflowRunStatus[] = [
  "PENDING",
  "RUNNING",
  "PAUSED_OTP",
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

async function isBullJobStillQueued(runId: string): Promise<boolean> {
  try {
    const job = await workflowQueue.getJob(runId);
    if (!job) return false;
    const state = await job.getState();
    return state === "active" || state === "waiting" || state === "delayed";
  } catch {
    return false;
  }
}

/** True when automation is actually executing or holding a live browser for this run. */
export async function isWorkflowRunLive(
  run: { id: string; status: WorkflowRunStatus; startedAt: Date },
): Promise<boolean> {
  if (await fetchAutomationSessionActive(run.id)) return true;
  if (await isWatchdogActive(run.id)) return true;

  const ageMs = Date.now() - run.startedAt.getTime();

  if (run.status === "PENDING") {
    if (ageMs < 3 * 60_000) return true;
    return isBullJobStillQueued(run.id);
  }

  if (run.status === "PAUSED_OTP") {
    if (ageMs < 12 * 60 * 60_000) {
      return isBullJobStillQueued(run.id) || ageMs < 2 * 60_000;
    }
    return false;
  }

  // RUNNING — live while browser session, watchdog, queue job, or short boot grace after START
  if (run.status === "RUNNING") {
    if (await isBullJobStillQueued(run.id)) return true;
    if (ageMs < 5 * 60_000) return true;
    return false;
  }

  return false;
}

export type ReconcileStaleResult = {
  clearedRunIds: string[];
};

/** Marks orphaned in-flight rows STOPPED so a new START is allowed. */
export async function reconcileStaleWorkflowRunsForDealer(dealerId: string): Promise<ReconcileStaleResult> {
  const inFlight = await prisma.workflowRun.findMany({
    where: {
      dealerId,
      status: { in: IN_FLIGHT_WORKFLOW_STATUSES },
    },
    orderBy: { startedAt: "asc" },
  });

  const clearedRunIds: string[] = [];

  for (const run of inFlight) {
    if (await isWorkflowRunLive(run)) continue;
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "STOPPED",
        endedAt: new Date(),
        errorMessage: STALE_END_MESSAGE,
      },
    });
    clearedRunIds.push(run.id);
  }

  return { clearedRunIds };
}

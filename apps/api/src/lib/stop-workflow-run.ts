import { SocketEvents } from "@gdms/shared";
import { prisma } from "../prisma.js";
import { env } from "../config.js";
import { setControl } from "../redis.js";
import { publishWorkflowEvent } from "../socket.js";
import { purgeBullJobArtifacts } from "./ensure-workflow-job.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

const ACTIVE_STATUSES = ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"] as const;

/** Stop one workflow run (Redis stop flag + DB + optional browser force-stop). */
export async function stopWorkflowRun(
  runId: string,
  dealerId: string,
  message: string,
): Promise<void> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run || !ACTIVE_STATUSES.includes(run.status as (typeof ACTIVE_STATUSES)[number])) {
    return;
  }

  await setControl(runId, "stop", "1");
  await setControl(runId, "pause", "0");

  if (run.status === "PENDING") {
    await purgeBullJobArtifacts(runId);
  } else {
    void fetch(`${automationBase()}/internal/force-stop/${runId}`, {
      method: "POST",
      headers: { "x-internal-secret": automationSecret() },
    }).catch(() => undefined);
  }

  await prisma.workflowRun.update({
    where: { id: runId },
    data: {
      status: "STOPPED",
      endedAt: new Date(),
      errorMessage: message,
    },
  });

  await publishWorkflowEvent({
    type: SocketEvents.LOG_LINE,
    dealerId,
    payload: {
      workflowRunId: runId,
      level: "info",
      message,
      ts: new Date().toISOString(),
    },
  });
}

/** Force-stop all active Follow Up Skip runs when settings toggle is turned off. */
export async function stopFollowUpSkipRunsForDealer(
  dealerId: string,
  reason = "Follow Up Skip disabled in Settings — automation stopped.",
): Promise<string[]> {
  const runs = await prisma.workflowRun.findMany({
    where: {
      dealerId,
      status: { in: [...ACTIVE_STATUSES] },
      runParams: { path: ["operation"], equals: "follow_up_skip" },
    },
    select: { id: true },
  });

  for (const run of runs) {
    await stopWorkflowRun(run.id, dealerId, reason);
  }

  return runs.map((r) => r.id);
}

/** Force-stop all active Lost Inquiry runs when settings toggle is turned off. */
export async function stopLostInquiryRunsForDealer(
  dealerId: string,
  reason = "Lost Inquiry disabled in Settings — automation stopped.",
): Promise<string[]> {
  const runs = await prisma.workflowRun.findMany({
    where: {
      dealerId,
      status: { in: [...ACTIVE_STATUSES] },
      runParams: { path: ["operation"], equals: "lost_inquiry" },
    },
    select: { id: true },
  });

  for (const run of runs) {
    await stopWorkflowRun(run.id, dealerId, reason);
  }

  return runs.map((r) => r.id);
}

import { createLogger } from "@gdms/logger";
import { isFollowUpSkipScheduleDue, nowIstParts, parseIstTimeHHmm, SocketEvents } from "@gdms/shared";
import { createPrisma } from "@gdms/database";
import { workflowQueue, type WorkflowJobData } from "../queue.js";
import { publishWorkflowEvent } from "../socket.js";
import { removeStaleBullJob } from "./ensure-workflow-job.js";
import { reconcileStaleWorkflowRunsForDealer } from "./stale-workflow-run.js";
import { resolveGdmsUserIdForDealerAutomation } from "./gdms-credentials.js";

const log = createLogger("enquiry-transfer-scheduler");
const prisma = createPrisma();

const DEFAULT_SCHEDULED_SOURCES = ["Digital"] as const;

export const enquiryFiredTodayKey = (dealerId: string, ymd: string, hhmm: string) =>
  `scheduler:enquiry_transfer:${dealerId}:${ymd}:${hhmm}`;

export type EnqueueEnquiryTransferResult =
  | { ok: true; runId: string; alreadyRunning?: boolean }
  | { ok: false; reason: string };

export async function enqueueScheduledEnquiryTransfer(
  dealerId: string,
  startTime: string,
): Promise<EnqueueEnquiryTransferResult> {
  const parsed = parseIstTimeHHmm(startTime);
  if (!parsed) return { ok: false, reason: "Invalid start time" };

  const { ymd } = nowIstParts();
  const redisKey = enquiryFiredTodayKey(dealerId, ymd, startTime);

  const { redis } = await import("../redis.js");
  if ((await redis.get(redisKey)) === "1") {
    return { ok: false, reason: "Already fired for this schedule today" };
  }

  const startedByUserId = await resolveGdmsUserIdForDealerAutomation(dealerId);
  if (!startedByUserId) {
    return { ok: false, reason: "No Team Leader or SC with GDMS credentials configured" };
  }

  await reconcileStaleWorkflowRunsForDealer(dealerId);

  const inFlight = await prisma.workflowRun.findFirst({
    where: {
      dealerId,
      status: { in: ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"] },
      runParams: { path: ["operation"], equals: "enquiry_transfer" },
    },
  });
  if (inFlight) {
    await redis.set(redisKey, "1", "EX", 86_400);
    return { ok: true, runId: inFlight.id, alreadyRunning: true };
  }

  const runParams = {
    operation: "enquiry_transfer",
    sources: [...DEFAULT_SCHEDULED_SOURCES],
    scheduled: true,
  };

  const run = await prisma.workflowRun.create({
    data: {
      dealerId,
      startedByUserId,
      status: "PENDING",
      currentStep: "enquiry_transfer",
      runParams,
    },
  });

  const jobData: WorkflowJobData = {
    runId: run.id,
    dealerId,
    startedByUserId,
    operation: "enquiry_transfer",
    sources: [...DEFAULT_SCHEDULED_SOURCES],
  };

  await removeStaleBullJob(run.id);
  await workflowQueue.add("execute", jobData, { jobId: run.id });
  await redis.set(redisKey, "1", "EX", 86_400);

  await prisma.dealerAutomationSettings.updateMany({
    where: { dealerId },
    data: { lastScheduledRunId: run.id, lastScheduledRunAt: new Date() },
  });

  await publishWorkflowEvent({
    type: SocketEvents.WORKFLOW_STARTED,
    dealerId,
    payload: { workflowRunId: run.id, dealerId, operation: "enquiry_transfer", scheduled: true },
  });

  log.info({ dealerId, runId: run.id, time: startTime }, "scheduled enquiry_transfer");
  return { ok: true, runId: run.id };
}

export function startEnquiryTransferScheduler(): void {
  const tick = async (): Promise<void> => {
    try {
      const settings = await prisma.dealerAutomationSettings.findMany({
        where: { enquiryTransferEnabled: true, enquiryTransferStartTime: { not: null } },
        include: { dealer: { select: { isActive: true } } },
      });

      for (const s of settings) {
        if (!s.dealer.isActive || !s.enquiryTransferStartTime) continue;
        if (!isFollowUpSkipScheduleDue(s.enquiryTransferStartTime)) continue;
        await enqueueScheduledEnquiryTransfer(s.dealerId, s.enquiryTransferStartTime);
      }
    } catch (err) {
      log.error({ err }, "enquiry-transfer scheduler tick failed");
    }
  };

  void tick();
  setInterval(() => void tick(), 15_000);
  log.info("Enquiry transfer daily scheduler started (IST, 15s poll)");
}

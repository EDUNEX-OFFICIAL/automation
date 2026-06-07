import { createLogger } from "@gdms/logger";
import {
  isLostInquiryScheduleDue,
  istIsoWeekKey,
  parseIstTimeHHmm,
  SocketEvents,
} from "@gdms/shared";
import { createPrisma } from "@gdms/database";
import { workflowQueue, type WorkflowJobData } from "../queue.js";
import { publishWorkflowEvent } from "../socket.js";
import { removeStaleBullJob } from "./ensure-workflow-job.js";
import { reconcileStaleWorkflowRunsForDealer } from "./stale-workflow-run.js";
import { resolveGdmsUserIdForDealerAutomation } from "./gdms-credentials.js";

const log = createLogger("lost-inquiry-scheduler");
const prisma = createPrisma();

/** Per dealer + ISO week + scheduled HH:mm — once per week on Saturday. */
export const firedWeekKey = (dealerId: string, isoWeek: string, hhmm: string) =>
  `scheduler:lost_inquiry:${dealerId}:${isoWeek}:${hhmm}`;

const schedulerKeyPattern = (dealerId: string) => `scheduler:lost_inquiry:${dealerId}:*`;

export async function clearLostInquirySchedulerKeys(dealerId: string): Promise<void> {
  const { redis } = await import("../redis.js");
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", schedulerKeyPattern(dealerId), "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

export type EnqueueLostInquiryResult =
  | { ok: true; runId: string; alreadyRunning?: boolean }
  | { ok: false; reason: string };

export async function enqueueScheduledLostInquiry(
  dealerId: string,
  startTime: string,
): Promise<EnqueueLostInquiryResult> {
  const parsed = parseIstTimeHHmm(startTime);
  if (!parsed) return { ok: false, reason: "Invalid start time" };

  const isoWeek = istIsoWeekKey();
  const redisKey = firedWeekKey(dealerId, isoWeek, startTime);

  const { redis } = await import("../redis.js");
  const already = await redis.get(redisKey);
  if (already === "1") {
    return { ok: false, reason: "Already fired for this schedule this week" };
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
      runParams: { path: ["operation"], equals: "lost_inquiry" },
    },
  });
  if (inFlight) {
    log.info({ dealerId, runId: inFlight.id }, "lost_inquiry already running — skip schedule");
    await redis.set(redisKey, "1", "EX", 604_800);
    return { ok: true, runId: inFlight.id, alreadyRunning: true };
  }

  const run = await prisma.workflowRun.create({
    data: {
      dealerId,
      startedByUserId,
      status: "PENDING",
      currentStep: "lost_inquiry",
      runParams: { operation: "lost_inquiry", sources: [] },
    },
  });

  const jobData: WorkflowJobData = {
    runId: run.id,
    dealerId,
    startedByUserId,
    operation: "lost_inquiry",
    sources: [],
  };

  await removeStaleBullJob(run.id);
  await workflowQueue.add("execute", jobData, { jobId: run.id });
  await redis.set(redisKey, "1", "EX", 604_800);
  await publishWorkflowEvent({
    type: SocketEvents.WORKFLOW_STARTED,
    dealerId,
    payload: {
      workflowRunId: run.id,
      dealerId,
      operation: "lost_inquiry",
      scheduled: true,
    },
  });
  log.info({ dealerId, runId: run.id, time: startTime }, "scheduled lost_inquiry");
  return { ok: true, runId: run.id };
}

export async function triggerLostInquiryIfDueNow(
  dealerId: string,
  startTime: string,
): Promise<EnqueueLostInquiryResult | null> {
  if (!isLostInquiryScheduleDue(startTime)) return null;
  return enqueueScheduledLostInquiry(dealerId, startTime);
}

export function startLostInquiryScheduler(): void {
  const tick = async (): Promise<void> => {
    try {
      const settings = await prisma.dealerAutomationSettings.findMany({
        where: { lostInquiryEnabled: true, lostInquiryStartTime: { not: null } },
      });

      for (const s of settings) {
        if (!s.lostInquiryStartTime) continue;
        if (!isLostInquiryScheduleDue(s.lostInquiryStartTime)) continue;

        const result = await enqueueScheduledLostInquiry(s.dealerId, s.lostInquiryStartTime);
        if (result.ok && !result.alreadyRunning) {
          log.info(
            { dealerId: s.dealerId, time: s.lostInquiryStartTime },
            "lost_inquiry started from weekly schedule",
          );
        }
      }
    } catch (err) {
      log.error({ err }, "lost-inquiry scheduler tick failed");
    }
  };

  void tick();
  setInterval(() => void tick(), 15_000);
  log.info("Lost Inquiry weekly scheduler started (IST Saturdays, 15s poll)");
}

import { createLogger } from "@gdms/logger";
import { isFollowUpSkipScheduleDue, nowIstParts, parseIstTimeHHmm, SocketEvents } from "@gdms/shared";
import { createPrisma } from "@gdms/database";
import { workflowQueue, type WorkflowJobData } from "../queue.js";
import { publishWorkflowEvent } from "../socket.js";
import { removeStaleBullJob } from "./ensure-workflow-job.js";
import { reconcileStaleWorkflowRunsForDealer } from "./stale-workflow-run.js";
import { resolveGdmsUserIdForDealerAutomation } from "./gdms-credentials.js";

const log = createLogger("follow-up-skip-scheduler");
const prisma = createPrisma();

/** Per dealer + day + scheduled HH:mm — changing time same day can fire again. */
export const firedTodayKey = (dealerId: string, ymd: string, hhmm: string) =>
  `scheduler:follow_up_skip:${dealerId}:${ymd}:${hhmm}`;

const schedulerKeyPattern = (dealerId: string) => `scheduler:follow_up_skip:${dealerId}:*`;

export async function clearFollowUpSkipSchedulerKeys(dealerId: string): Promise<void> {
  const { redis } = await import("../redis.js");
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", schedulerKeyPattern(dealerId), "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

export type EnqueueFollowUpSkipResult =
  | { ok: true; runId: string; alreadyRunning?: boolean }
  | { ok: false; reason: string };

/** Queue one scheduled Follow Up Skip run for a dealer (idempotent per day+time). */
export async function enqueueScheduledFollowUpSkip(
  dealerId: string,
  startTime: string,
): Promise<EnqueueFollowUpSkipResult> {
  const parsed = parseIstTimeHHmm(startTime);
  if (!parsed) return { ok: false, reason: "Invalid start time" };

  const { ymd } = nowIstParts();
  const redisKey = firedTodayKey(dealerId, ymd, startTime);

  const { redis } = await import("../redis.js");
  const already = await redis.get(redisKey);
  if (already === "1") {
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
      runParams: { path: ["operation"], equals: "follow_up_skip" },
    },
  });
  if (inFlight) {
    log.info({ dealerId, runId: inFlight.id }, "follow_up_skip already running — skip schedule");
    await redis.set(redisKey, "1", "EX", 86_400);
    return { ok: true, runId: inFlight.id, alreadyRunning: true };
  }

  const run = await prisma.workflowRun.create({
    data: {
      dealerId,
      startedByUserId,
      status: "PENDING",
      currentStep: "follow_up_skip",
      runParams: { operation: "follow_up_skip", sources: [] },
    },
  });

  const jobData: WorkflowJobData = {
    runId: run.id,
    dealerId,
    startedByUserId,
    operation: "follow_up_skip",
    sources: [],
  };

  await removeStaleBullJob(run.id);
  await workflowQueue.add("execute", jobData, { jobId: run.id });
  await redis.set(redisKey, "1", "EX", 86_400);
  await publishWorkflowEvent({
    type: SocketEvents.WORKFLOW_STARTED,
    dealerId,
    payload: {
      workflowRunId: run.id,
      dealerId,
      operation: "follow_up_skip",
      scheduled: true,
    },
  });
  log.info({ dealerId, runId: run.id, time: startTime }, "scheduled follow_up_skip");
  return { ok: true, runId: run.id };
}

/** If settings were saved for the current IST minute, start immediately. */
/** Start if today's schedule time has been reached (not only the exact IST minute). */
export async function triggerFollowUpSkipIfDueNow(
  dealerId: string,
  startTime: string,
): Promise<EnqueueFollowUpSkipResult | null> {
  if (!isFollowUpSkipScheduleDue(startTime)) return null;
  return enqueueScheduledFollowUpSkip(dealerId, startTime);
}

/** Daily IST trigger for dealers with Follow Up Skip enabled. */
export function startFollowUpSkipScheduler(): void {
  const tick = async (): Promise<void> => {
    try {
      const settings = await prisma.dealerAutomationSettings.findMany({
        where: { followUpSkipEnabled: true, followUpSkipStartTime: { not: null } },
      });

      for (const s of settings) {
        if (!s.followUpSkipStartTime) continue;
        if (!isFollowUpSkipScheduleDue(s.followUpSkipStartTime)) continue;

        const result = await enqueueScheduledFollowUpSkip(s.dealerId, s.followUpSkipStartTime);
        if (result.ok && !result.alreadyRunning) {
          log.info(
            { dealerId: s.dealerId, time: s.followUpSkipStartTime },
            "follow_up_skip started from daily schedule",
          );
        } else if (!result.ok && result.reason === "Already fired for this schedule today") {
          log.debug({ dealerId: s.dealerId, time: s.followUpSkipStartTime }, "schedule slot already used today");
        }
      }
    } catch (err) {
      log.error({ err }, "follow-up-skip scheduler tick failed");
    }
  };

  void tick();
  setInterval(() => void tick(), 15_000);
  log.info("Follow Up Skip daily scheduler started (IST, fires at or after set time, 15s poll)");
}

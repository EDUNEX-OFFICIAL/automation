import { getActiveSession } from "./active-sessions.js";
import { runFollowUpSkip } from "./follow-up-skip.js";
import { loadDealerRemarkConfig } from "./dealer-remark-config.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";
import { createPrisma } from "@gdms/database";
import { Redis } from "ioredis";
import { SocketEvents, WORKFLOW_REDIS_CHANNEL, type LogLinePayload } from "@gdms/shared";
import { env } from "./config.js";
import { redisControlKey } from "./gdms-session-watch.js";

const prisma = createPrisma();

async function publish(redis: Redis, type: string, dealerId: string, payload: unknown): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

/** Continue follow-up-skip on an already-open browser session. */
export async function retryFollowUpSkip(runId: string): Promise<void> {
  const session = getActiveSession(runId);
  if (!session) {
    throw new Error("No active browser session for this run.");
  }

  const redisClient = new Redis(env.REDIS_URL);
  const { page, dealerId } = session;

  const log = async (level: LogLinePayload["level"], message: string) => {
    await publish(redisClient, SocketEvents.LOG_LINE, dealerId, {
      workflowRunId: runId,
      level,
      message,
      ts: new Date().toISOString(),
    });
  };

  const shouldStop = async (): Promise<boolean> =>
    (await redisClient.get(redisControlKey(runId, "stop"))) === "1";

  const waitIfPaused = async (): Promise<void> => {
    for (let i = 0; i < 7200; i++) {
      if (await shouldStop()) throw new Error("stopped");
      if ((await redisClient.get(redisControlKey(runId, "pause"))) !== "1") return;
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const signalManualIntervention = async (message: string): Promise<never> => {
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "PAUSED_USER", errorMessage: message, endedAt: new Date() },
    });
    await publish(redisClient, SocketEvents.WORKFLOW_PAUSED_USER, dealerId, {
      workflowRunId: runId,
      message,
    });
    await log("error", message);
    throw new Error(ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE);
  };

  try {
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "RUNNING", errorMessage: null, endedAt: null },
    });
    await log("info", "Continuing Follow Up Skip on open browser session.");
    const remarkConfig = await loadDealerRemarkConfig(dealerId);
    await runFollowUpSkip({
      page,
      runId,
      dealerId,
      redis: redisClient,
      followUpSkipRemarkBases: remarkConfig.followUpSkipRemarkBases,
      log,
      shouldStop,
      waitIfPaused,
      signalManualIntervention,
    });
  } finally {
    redisClient.disconnect();
  }
}

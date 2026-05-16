import { Redis } from "ioredis";

import { createPrisma } from "@gdms/database";

import { SocketEvents, WORKFLOW_REDIS_CHANNEL, type LogLinePayload } from "@gdms/shared";

import { getActiveSession } from "./active-sessions.js";

import { runEnquiryTransfer } from "./enquiry-transfer.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";

import {
  isOnCustomerEnquiryList,
  redisControlKey,
  setResumeTransferRequest,
  waitForGdmsDashboardReady,
} from "./gdms-session-watch.js";

import { applyInputGuardToPage } from "./automation-browser-setup.js";
import { env } from "./config.js";

const prisma = createPrisma();

async function publish(redis: Redis, type: string, dealerId: string, payload: unknown): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

async function isStopped(redis: Redis, runId: string): Promise<boolean> {
  return (await redis.get(redisControlKey(runId, "stop"))) === "1";
}

async function waitIfPaused(redis: Redis, runId: string): Promise<void> {
  for (let i = 0; i < 7200; i++) {
    if (await isStopped(redis, runId)) throw new Error("stopped");
    if ((await redis.get(redisControlKey(runId, "pause"))) !== "1") return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Resume or restart enquiry transfer on the open visible browser. */
export async function retryEnquiryTransfer(runId: string): Promise<void> {
  const session = getActiveSession(runId);
  if (!session) {
    throw new Error("No active browser session for this run — start a new automation from the dashboard.");
  }

  const redisClient = new Redis(env.REDIS_URL);
  const { page, payload, dealerId } = session;

  await applyInputGuardToPage(page);

  const log = async (level: LogLinePayload["level"], message: string) => {
    await publish(redisClient, SocketEvents.LOG_LINE, dealerId, {
      workflowRunId: runId,
      level,
      message,
      ts: new Date().toISOString(),
    });
  };

  try {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });

    if (run?.status === "RUNNING") {
      await setResumeTransferRequest(redisClient, runId);
      await log(
        "info",
        "Continue transfer signalled — if GDMS home is already open, automation will proceed shortly.",
      );
      return;
    }

    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "RUNNING", errorMessage: null, endedAt: null },
    });
    await publish(redisClient, SocketEvents.WORKFLOW_STARTED, dealerId, {
      workflowRunId: runId,
      dealerId,
    });
    await log("info", "Restarting enquiry transfer on the active browser session.");

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

    if (!(await isOnCustomerEnquiryList(page))) {
      await waitForGdmsDashboardReady(page, log, 180_000, {
        redis: redisClient,
        runId,
        dealerId,
        shouldStop: () => isStopped(redisClient, runId),
      });
    } else {
      await log("info", "Already on Customer Enquiry — continuing search.");
    }

    await runEnquiryTransfer({
      page,
      runId,
      dealerId,
      redis: redisClient,
      sources: payload.sources,
      subSources: payload.subSources,
      log,
      shouldStop: () => isStopped(redisClient, runId),
      waitIfPaused: () => waitIfPaused(redisClient, runId),
      signalManualIntervention,
    });
  } catch (e) {
    const msg = String(e);
    const stopped = msg === "stopped" || (e instanceof Error && e.message === "stopped");
    const pausedUser =
      e instanceof Error && e.message === ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE;

    if (stopped) {
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: "STOPPED", endedAt: new Date(), errorMessage: msg },
      });
      throw e;
    }

    const operatorMsg = pausedUser
      ? "Automation paused — complete the step in GDMS, then press Resume on Live session."
      : msg;
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "PAUSED_USER", errorMessage: operatorMsg, endedAt: new Date() },
    });
    await publish(redisClient, SocketEvents.WORKFLOW_PAUSED_USER, dealerId, {
      workflowRunId: runId,
      message: operatorMsg,
    });
    await log(pausedUser ? "warn" : "error", operatorMsg);
    await log(
      "info",
      "Browser session kept open — use Resume saved session or Retry transfer when ready.",
    );
  } finally {
    redisClient.disconnect();
  }
}

import path from "node:path";
import { Redis } from "ioredis";
import { createPrisma } from "@gdms/database";
import { SocketEvents, WORKFLOW_REDIS_CHANNEL, type LogLinePayload } from "@gdms/shared";
import { displayForUserOperation } from "@gdms/shared";
import { launchGdmsPersistentContext } from "./browser-profile.js";
import { startGdmsBrowserWindowTitleRefresh } from "./gdms-browser-window-title.js";
import {
  browserProfileKeyForOperation,
  closeActiveSessionsForDealer,
  getActiveSession,
  registerActiveSession,
} from "./active-sessions.js";
import { runFollowUpSkip } from "./follow-up-skip.js";
import { loadDealerRemarkConfig } from "./dealer-remark-config.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";
import {
  attachInputGuardListeners,
  attachNonFatalNetworkLogging,
  installAutomationBrowserScripts,
} from "./automation-browser-setup.js";
import { resolveGdmsHomeUrl } from "@gdms/shared";
import { applyGdmsBootstrapCookies } from "./gdms-cookie-bootstrap.js";
import {
  isGdmsDashboardReady,
  isOnTodaysFollowUpList,
  pickGdmsWorkPage,
  redisControlKey,
} from "./gdms-session-watch.js";
import { assertEnquiryTransferBrowserMode } from "./browser-context.js";
import { createPreviewStream } from "./preview-stream.js";
import { env } from "./config.js";
import type { ExecutePayload } from "./runner.js";
import { retryFollowUpSkip } from "./retry-follow-up-skip.js";

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

/** Re-open follow-up-skip browser profile and continue Today's Follow Up loop. */
export async function resumeFollowUpSkip(payload: ExecutePayload): Promise<void> {
  if (payload.operation !== "follow_up_skip") {
    throw new Error("Resume is only supported for follow up skip runs.");
  }

  if (getActiveSession(payload.runId)) {
    await retryFollowUpSkip(payload.runId);
    return;
  }

  assertEnquiryTransferBrowserMode();

  const redisClient = new Redis(env.REDIS_URL);
  const { runId, dealerId } = payload;
  const profileKey = browserProfileKeyForOperation(
    dealerId,
    payload.operation,
    payload.startedByUserId,
  );

  const log = async (level: LogLinePayload["level"], message: string) => {
    await publish(redisClient, SocketEvents.LOG_LINE, dealerId, {
      workflowRunId: runId,
      level,
      message,
      ts: new Date().toISOString(),
    });
  };

  const sessionDir = path.join(env.SESSIONS_DIR, profileKey);
  await closeActiveSessionsForDealer(dealerId, profileKey);
  const vncDisplay = displayForUserOperation(payload.startedByUserId, payload.operation);
  const context = await launchGdmsPersistentContext(sessionDir, {
    display: vncDisplay,
  });
  startGdmsBrowserWindowTitleRefresh(vncDisplay, payload.operation);

  await installAutomationBrowserScripts(context);
  attachNonFatalNetworkLogging(context, (m) => void log("warn", m));

  const bootstrapCookiesApplied = await applyGdmsBootstrapCookies(
    context,
    sessionDir,
    payload.startedByUserId,
  );
  if (bootstrapCookiesApplied) {
    await log("info", "GDMS bootstrap cookies applied on resume.");
  }

  let page = await context.newPage();
  const detachInputGuard = attachInputGuardListeners(page);

  const preview = createPreviewStream({
    runId,
    dealerId,
    getPage: () => page,
    publish: (type, dId, frame) => publish(redisClient, type, dId, frame),
    isStopped: () => isStopped(redisClient, runId),
    operation: payload.operation,
  });
  preview.startLoop();

  registerActiveSession({
    runId,
    dealerId,
    startedByUserId: payload.startedByUserId,
    profileKey,
    page,
    context,
    payload,
    captureFrame: preview.captureFrame,
    stopScreenshots: preview.stopLoop,
  });

  try {
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "RUNNING", errorMessage: null, endedAt: null },
    });
    await publish(redisClient, SocketEvents.WORKFLOW_STARTED, dealerId, {
      workflowRunId: runId,
      dealerId,
    });
    await log("info", "Resuming Follow Up Skip from saved browser profile (workspace 2).");

    page = await pickGdmsWorkPage(context);
    const baseUrl =
      payload.loginWorkflow.steps.find((s) => s.type === "navigate" && s.url)?.url ??
      env.GDMS_BASE_URL;
    if (baseUrl && !(await isOnTodaysFollowUpList(page))) {
      await page.goto(baseUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    }

    if (!(await isGdmsDashboardReady(page))) {
      const homeUrl = resolveGdmsHomeUrl(env.GDMS_HOME_URL);
      if (homeUrl) {
        await page.goto(homeUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
      }
    }

    if (!(await isGdmsDashboardReady(page))) {
      await preview.captureFrame();
      throw new Error(
        "GDMS is not logged in on the follow-up browser profile. Submit OTP in the popup when it appears.",
      );
    }

    await log("info", "GDMS home detected — skipping login if session is valid.");

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

    const remarkConfig = await loadDealerRemarkConfig(dealerId);
    await runFollowUpSkip({
      page,
      runId,
      dealerId,
      redis: redisClient,
      followUpSkipRemarkBases: remarkConfig.followUpSkipRemarkBases,
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
  } finally {
    detachInputGuard();
    redisClient.disconnect();
  }
}

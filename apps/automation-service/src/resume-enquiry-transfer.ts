import fs from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import { chromium } from "playwright";
import { createPrisma } from "@gdms/database";
import { SocketEvents, WORKFLOW_REDIS_CHANNEL, type LogLinePayload } from "@gdms/shared";
import {
  getActiveSession,
  registerActiveSession,
} from "./active-sessions.js";
import { runEnquiryTransfer } from "./enquiry-transfer.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";
import {
  attachInputGuardListeners,
  installAutomationBrowserScripts,
} from "./automation-browser-setup.js";
import { applyGdmsBootstrapCookies } from "./gdms-cookie-bootstrap.js";
import {
  isGdmsDashboardReady,
  isOnCustomerEnquiryList,
  pickGdmsWorkPage,
  redisControlKey,
  waitForGdmsDashboardReady,
} from "./gdms-session-watch.js";
import { env } from "./config.js";
import type { ExecutePayload } from "./runner.js";
import { retryEnquiryTransfer } from "./retry-enquiry-transfer.js";

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

/**
 * Re-open the dealer Playwright profile for an existing run and continue enquiry transfer
 * (skips OTP when cookies still show GDMS home).
 */
export async function resumeEnquiryTransfer(payload: ExecutePayload): Promise<void> {
  if (payload.operation !== "enquiry_transfer") {
    throw new Error("Resume is only supported for enquiry transfer runs.");
  }

  if (getActiveSession(payload.runId)) {
    await retryEnquiryTransfer(payload.runId);
    return;
  }

  if (!env.PLAYWRIGHT_HEADED) {
    throw new Error(
      "Enquiry transfer requires PLAYWRIGHT_HEADED=true (visible browser only — set it in apps/automation-service/.env and restart pnpm dev).",
    );
  }

  const redisClient = new Redis(env.REDIS_URL);
  const { runId, dealerId } = payload;

  const log = async (level: LogLinePayload["level"], message: string) => {
    await publish(redisClient, SocketEvents.LOG_LINE, dealerId, {
      workflowRunId: runId,
      level,
      message,
      ts: new Date().toISOString(),
    });
  };

  const sessionDir = path.join(env.SESSIONS_DIR, dealerId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  await installAutomationBrowserScripts(context);

  if (await applyGdmsBootstrapCookies(context, sessionDir)) {
    await log("info", "GDMS bootstrap cookies applied from env.");
  }

  const page = await pickGdmsWorkPage(context);
  for (const p of context.pages()) {
    if (!p.isClosed()) attachInputGuardListeners(p);
  }
  await log(
    "info",
    "GDMS browser input locked during automation — use Stop on Live session to interrupt.",
  );
  const captureFrame = async (): Promise<void> => {};
  registerActiveSession({
    runId,
    dealerId,
    page,
    context,
    payload,
    captureFrame,
    stopScreenshots: () => {},
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
    await log("info", "Resuming enquiry transfer from saved browser profile (same run).");

    const onList = await isOnCustomerEnquiryList(page);
    const baseUrl =
      payload.loginWorkflow.steps.find((s) => s.type === "navigate" && s.url)?.url ??
      env.GDMS_BASE_URL;

    if (onList) {
      await log("info", "Reusing browser tab already on Sales Customer Enquiry list.");
    } else if (baseUrl) {
      await page.goto(baseUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    }

    if (!onList && !(await isGdmsDashboardReady(page))) {
      const homeUrl = env.GDMS_BASE_URL;
      if (homeUrl && homeUrl !== baseUrl) {
        await page.goto(homeUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
      }
    }

    if (!(await isGdmsDashboardReady(page))) {
      throw new Error(
        "GDMS is not logged in on this device profile. Log in once from the dashboard (OTP), then use Resume saved session again.",
      );
    }

    await log("info", "GDMS home screen detected from profile — skipping login and OTP.");

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

    if (await isOnCustomerEnquiryList(page)) {
      await log("info", "Already on Sales Customer Enquiry list — continuing search (no re-navigation).");
    } else {
      await waitForGdmsDashboardReady(page, log, 180_000, {
        redis: redisClient,
        runId,
        dealerId,
        shouldStop: () => isStopped(redisClient, runId),
      });
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

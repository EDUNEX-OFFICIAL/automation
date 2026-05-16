import { Redis } from "ioredis";
import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { createPrisma } from "@gdms/database";
import {
  SocketEvents,
  WORKFLOW_REDIS_CHANNEL,
  type LogLinePayload,
  type ScreenshotFramePayload,
} from "@gdms/shared";
import type { WorkflowDefinition, WorkflowStep } from "@gdms/workflow-engine";
import { ingestInquiriesFromPage } from "./ingest-inquiries.js";
import {
  ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE,
  runEnquiryTransfer,
} from "./enquiry-transfer.js";
import { applyGdmsBootstrapCookies } from "./gdms-cookie-bootstrap.js";
import { humanDelay } from "./human-delay.js";
import { env } from "./config.js";
import { detectGdmsLoginError, gdmsLoginErrorMessage } from "./gdms-login-errors.js";
import {
  isGdmsDashboardReady,
  isGdmsLoggedIn,
  redisControlKey,
  waitForGdmsDashboardReady,
  watchGdmsSession,
} from "./gdms-session-watch.js";
import {
  attachInputGuardListeners,
  installAutomationBrowserScripts,
} from "./automation-browser-setup.js";
import {
  getActiveSession,
  registerActiveSession,
  unregisterActiveSession,
} from "./active-sessions.js";

const prisma = createPrisma();

function shouldKeepBrowserOnFailure(): boolean {
  if (env.GDMS_KEEP_BROWSER_ON_FAILURE !== undefined) {
    return env.GDMS_KEEP_BROWSER_ON_FAILURE;
  }
  return env.PLAYWRIGHT_HEADED;
}

async function isPaused(redis: Redis, runId: string): Promise<boolean> {
  const v = await redis.get(redisControlKey(runId, "pause"));
  return v === "1";
}

async function isStopped(redis: Redis, runId: string): Promise<boolean> {
  const v = await redis.get(redisControlKey(runId, "stop"));
  return v === "1";
}

async function waitIfPaused(redis: Redis, runId: string): Promise<void> {
  for (let i = 0; i < 7200; i++) {
    if (await isStopped(redis, runId)) throw new Error("stopped");
    if (!(await isPaused(redis, runId))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function publish(
  redis: Redis,
  type: string,
  dealerId: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

async function waitForOtp(redis: Redis, runId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isStopped(redis, runId)) throw new Error("stopped");
    const v = await redis.get(`run:${runId}:otp`);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("OTP timeout");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `pw:ph|User ID` / `pw:btn|Send OTP` — HMIL/Hyundai DMS style forms without brittle CSS. */
function parsePwLocator(sel: string):
  | { kind: "placeholder"; text: string }
  | { kind: "button"; name: string }
  | null {
  if (!sel.startsWith("pw:")) return null;
  const rest = sel.slice(3);
  const bar = rest.indexOf("|");
  if (bar <= 0) return null;
  const k = rest.slice(0, bar).trim().toLowerCase();
  const v = rest.slice(bar + 1).trim();
  if (!v) return null;
  if (k === "ph" || k === "placeholder") return { kind: "placeholder", text: v };
  if (k === "btn" || k === "button") return { kind: "button", name: v };
  return null;
}

/** HMIL: button accessible name / visible text often ≠ exact "^Login$" — role + substring match. */
async function clickPwButton(page: Page, name: string, timeout: number, stepId: string): Promise<void> {
  const re = new RegExp(escapeRegExp(name), "i");
  let locator = page.getByRole("button", { name: re }).first();
  try {
    await locator.waitFor({ state: "visible", timeout: Math.min(timeout, 12_000) });
  } catch {
    try {
      locator = page.getByRole("link", { name: re }).first();
      await locator.waitFor({ state: "visible", timeout: Math.min(timeout, 12_000) });
    } catch {
      locator = page.getByText(re).first();
      await locator.waitFor({ state: "visible", timeout });
    }
  }
  await locator.click({ timeout });
  if (stepId === "final_login") {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 90_000) }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}

function resolveValue(
  step: WorkflowStep,
  creds: { gdmsUsername: string; gdmsPassword: string; otp?: string },
): string | undefined {
  if (step.valueFrom === "gdmsUsername") return creds.gdmsUsername;
  if (step.valueFrom === "gdmsPassword") return creds.gdmsPassword;
  if (step.valueFrom === "otp") return creds.otp;
  if (step.valueFrom === "static") return step.staticValue;
  return undefined;
}

export type ExecutePayload = {
  runId: string;
  dealerId: string;
  gdmsUsername: string;
  gdmsPassword: string;
  loginWorkflow: WorkflowDefinition;
  operationWorkflow: WorkflowDefinition;
  operation: string;
  sources: string[];
  subSources?: Record<string, string[]>;
  /** @deprecated legacy single-workflow execute */
  workflow?: WorkflowDefinition;
  kind?: string;
};

async function executeStep(
  page: Page,
  step: WorkflowStep,
  runId: string,
  dealerId: string,
  redisClient: Redis,
  waitOtpFn: () => Promise<void>,
  creds: { gdmsUsername: string; gdmsPassword: string; otp?: string },
): Promise<void> {
  const timeout = step.timeoutMs ?? 60_000;
  if (step.type === "navigate") {
    const url = step.url ?? env.GDMS_BASE_URL;
    await page.goto(url, { timeout });
    return;
  }
  if (step.type === "fill") {
    const sel = step.selector;
    if (!sel) throw new Error("fill requires selector");
    const val = resolveValue(step, creds);
    if (val === undefined) throw new Error("fill missing value");
    const pw = parsePwLocator(sel);
    if (pw?.kind === "placeholder") {
      const ph = page.getByPlaceholder(new RegExp(escapeRegExp(pw.text), "i"));
      await ph.waitFor({ state: "visible", timeout });
      await ph.fill(val, { timeout });
      return;
    }
    await page.waitForSelector(sel, { timeout });
    await page.fill(sel, val, { timeout });
    return;
  }
  if (step.type === "click") {
    const sel = step.selector;
    if (!sel) throw new Error("click requires selector");
    const pw = parsePwLocator(sel);
    if (pw?.kind === "button") {
      await clickPwButton(page, pw.name, timeout, step.id);
      return;
    }
    await page.waitForSelector(sel, { timeout });
    await page.click(sel, { timeout });
    return;
  }
  if (step.type === "wait_selector") {
    const sel = step.selector;
    if (!sel) throw new Error("wait_selector requires selector");
    await page.waitForSelector(sel, { timeout });
    return;
  }
  if (step.type === "assert_no_gdms_login_error") {
    const detected = await detectGdmsLoginError(page, 2500);
    if (detected) throw new Error(gdmsLoginErrorMessage(detected));
    return;
  }
  if (step.type === "wait_for_gdms_dashboard") {
    await waitForGdmsDashboardReady(
      page,
      async (level, message) => {
        await publish(redisClient, SocketEvents.LOG_LINE, dealerId, {
          workflowRunId: runId,
          level,
          message,
          ts: new Date().toISOString(),
        });
      },
      step.timeoutMs ?? 180_000,
      {
        redis: redisClient,
        runId,
        dealerId,
        shouldStop: () => isStopped(redisClient, runId),
      },
    );
    return;
  }
  if (step.type === "wait_for_otp") {
    const detected = await detectGdmsLoginError(page, 1500);
    if (detected) throw new Error(gdmsLoginErrorMessage(detected));
    await publish(redisClient, SocketEvents.OTP_REQUIRED, dealerId, {
      workflowRunId: runId,
      hint: step.label,
    });
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "PAUSED_OTP" },
    });
    await waitOtpFn();
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "RUNNING" },
    });
    return;
  }
  if (step.type === "extract_table" || step.type === "custom") {
    await new Promise((r) => setTimeout(r, 500));
    return;
  }
  throw new Error(`Unknown step type ${step.type}`);
}

export async function runWorkflow(payload: ExecutePayload): Promise<void> {
  const redisClient = new Redis(env.REDIS_URL);
  let seq = 0;
  let context: BrowserContext | null = null;
  let shotLoop: ReturnType<typeof setInterval> | null = null;
  let otpResolved: string | undefined;
  let browserRetained = false;
  let page: Page | null = null;
  let detachInputGuard: (() => void) | null = null;
  let captureFrame: () => Promise<void> = async () => {};

  const log = async (level: LogLinePayload["level"], message: string) => {
    const line: LogLinePayload = {
      workflowRunId: payload.runId,
      level,
      message,
      ts: new Date().toISOString(),
    };
    await publish(redisClient, SocketEvents.LOG_LINE, payload.dealerId, line);
  };

  const baseCreds = {
    gdmsUsername: payload.gdmsUsername,
    gdmsPassword: payload.gdmsPassword,
  };

  try {
    await prisma.workflowRun.update({
      where: { id: payload.runId },
      data: { status: "RUNNING", errorMessage: null },
    });

    await publish(redisClient, SocketEvents.WORKFLOW_STARTED, payload.dealerId, {
      workflowRunId: payload.runId,
      dealerId: payload.dealerId,
    });

    if (payload.operation === "enquiry_transfer" && !env.PLAYWRIGHT_HEADED) {
      throw new Error(
        "Enquiry transfer requires PLAYWRIGHT_HEADED=true (visible browser only — set it in apps/automation-service/.env and restart pnpm dev).",
      );
    }

    const sessionDir = path.join(env.SESSIONS_DIR, payload.dealerId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const headed = env.PLAYWRIGHT_HEADED;
    context = await chromium.launchPersistentContext(sessionDir, {
      headless: !headed,
      args: headed ? [] : ["--no-sandbox", "--disable-dev-shm-usage"],
      viewport: { width: 1280, height: 800 },
    });

    await installAutomationBrowserScripts(context);

    if (await applyGdmsBootstrapCookies(context, sessionDir)) {
      await log("info", "GDMS bootstrap cookies applied from env.");
    }

    page = await context.newPage();

    if (payload.operation === "enquiry_transfer") {
      detachInputGuard = attachInputGuardListeners(page);
      await log(
        "info",
        "GDMS browser input locked during automation — use Stop on Live session to interrupt.",
      );
    }

    /** Preview streaming only when headless non-transfer jobs need remote visibility. */
    const screenshotsEnabled = !headed && payload.operation !== "enquiry_transfer";
    const shotMs = 2000;
    captureFrame = async (): Promise<void> => {
      if (!screenshotsEnabled) return;
      try {
        if (!page || (await isStopped(redisClient, payload.runId))) return;
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        const frame: ScreenshotFramePayload = {
          workflowRunId: payload.runId,
          imageBase64: buf.toString("base64"),
          seq: ++seq,
        };
        await publish(redisClient, SocketEvents.SCREENSHOT_FRAME, payload.dealerId, frame);
      } catch {
        /* ignore sporadic screenshot races */
      }
    };

    if (screenshotsEnabled) {
      void captureFrame();
      shotLoop = setInterval(() => {
        void captureFrame();
      }, shotMs);
    }

    if (payload.operation === "enquiry_transfer" && context && page) {
      browserRetained = true;
      registerActiveSession({
        runId: payload.runId,
        dealerId: payload.dealerId,
        page,
        context,
        payload,
        captureFrame,
        stopScreenshots: () => {
          if (shotLoop) {
            clearInterval(shotLoop);
            shotLoop = null;
          }
        },
      });
    }

    const legacyWorkflow = payload.workflow;
    const loginWorkflow = payload.loginWorkflow ?? legacyWorkflow;
    const operationWorkflow = payload.operationWorkflow ?? legacyWorkflow;
    if (!loginWorkflow || !operationWorkflow) {
      throw new Error("Missing login or operation workflow definition");
    }

    const baseUrl =
      loginWorkflow.steps.find((s) => s.type === "navigate" && s.url)?.url ??
      env.GDMS_BASE_URL;

    if (baseUrl) {
      await page.goto(baseUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });
    }

    const skipLogin =
      payload.operation === "enquiry_transfer"
        ? await isGdmsDashboardReady(page)
        : await isGdmsLoggedIn(page);
    const stepGroups: { label: string; steps: WorkflowDefinition["steps"] }[] = [];
    if (skipLogin) {
      await log(
        "info",
        payload.operation === "enquiry_transfer"
          ? "GDMS home screen detected — skipping login."
          : "GDMS session active — skipping login.",
      );
      stepGroups.push({ label: "operation", steps: operationWorkflow.steps });
    } else {
      stepGroups.push({ label: "login", steps: loginWorkflow.steps });
      stepGroups.push({ label: "operation", steps: operationWorkflow.steps });
    }

    if (payload.operation && payload.sources.length > 0) {
      const subSummary = payload.subSources
        ? Object.entries(payload.subSources)
            .map(([k, v]) => `${k}: ${v.join(", ")}`)
            .join("; ")
        : "none";
      await log(
        "info",
        `Operation ${payload.operation} — sources: ${payload.sources.join(", ")}; sub-sources: ${subSummary}`,
      );
    }

    const runCtx = {
      shouldStop: () => isStopped(redisClient, payload.runId),
      waitIfPaused: () => waitIfPaused(redisClient, payload.runId),
    };

    for (const group of stepGroups) {
      for (const step of group.steps) {
        if (group.label === "operation" && step.type === "navigate" && skipLogin) {
          continue;
        }

        if (await isStopped(redisClient, payload.runId)) throw new Error("stopped");
        await waitIfPaused(redisClient, payload.runId);

        const creds = {
          ...baseCreds,
          ...(otpResolved ? { otp: otpResolved } : {}),
        };

        const waitOtp = async () => {
          otpResolved = await waitForOtp(redisClient, payload.runId, step.timeoutMs ?? 600_000);
        };

        const retries = step.retries ?? 2;
        let lastErr: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            await executeStep(page, step, payload.runId, payload.dealerId, redisClient, waitOtp, creds);
            lastErr = undefined;
            break;
          } catch (e) {
            lastErr = e;
            await log("warn", `Step ${step.id} retry ${attempt}: ${String(e)}`);
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
        if (lastErr) throw lastErr;

        await publish(redisClient, SocketEvents.STEP_COMPLETED, payload.dealerId, {
          workflowRunId: payload.runId,
          stepId: step.id,
          label: step.label,
        });
        await prisma.workflowRun.update({
          where: { id: payload.runId },
          data: { currentStep: step.id },
        });
        await log("info", `Completed step ${step.label}`);
      }
    }

    const signalManualIntervention = async (message: string): Promise<never> => {
      await prisma.workflowRun.update({
        where: { id: payload.runId },
        data: { status: "PAUSED_USER", errorMessage: message, endedAt: new Date() },
      });
      await publish(redisClient, SocketEvents.WORKFLOW_PAUSED_USER, payload.dealerId, {
        workflowRunId: payload.runId,
        message,
      });
      await log("error", message);
      throw new Error(ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE);
    };

    if (payload.operation === "enquiry_transfer") {
      await log("info", "Starting enquiry transfer automation (runs until Stop).");
      await humanDelay(800, 1500);
      await runEnquiryTransfer({
        page,
        runId: payload.runId,
        dealerId: payload.dealerId,
        redis: redisClient,
        sources: payload.sources,
        subSources: payload.subSources,
        log,
        shouldStop: runCtx.shouldStop,
        waitIfPaused: runCtx.waitIfPaused,
        signalManualIntervention,
      });
      await humanDelay(500, 1200);
    }

    if (payload.kind === "inquiry_fetch") {
      await ingestInquiriesFromPage(page, payload.dealerId, redisClient, prisma, log);
    }

    if (payload.operation !== "enquiry_transfer") {
      await prisma.workflowRun.update({
        where: { id: payload.runId },
        data: { status: "COMPLETED", endedAt: new Date() },
      });

      await publish(redisClient, SocketEvents.WORKFLOW_COMPLETED, payload.dealerId, {
        workflowRunId: payload.runId,
      });
    }

    if (
      (payload.operation || payload.kind === "gdms_login") &&
      payload.operation !== "enquiry_transfer" &&
      context &&
      page
    ) {
      const endReason = await watchGdmsSession({
        page,
        context,
        runId: payload.runId,
        baseUrl: env.GDMS_BASE_URL,
        redis: redisClient,
        log,
        publish: (type, p) => publish(redisClient, type, payload.dealerId, p),
        shouldStop: () => isStopped(redisClient, payload.runId),
      });
      if (endReason === "stopped") {
        await prisma.workflowRun.update({
          where: { id: payload.runId },
          data: { status: "STOPPED", endedAt: new Date() },
        });
        await log("info", "Live preview stopped.");
      }
    }
  } catch (e) {
    const raw = String(e);
    const stopped =
      raw === "stopped" ||
      /^Error:\s*stopped$/i.test(raw.trim()) ||
      (e instanceof Error && e.message === "stopped");
    const pausedUser =
      e instanceof Error && e.message === ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE;
    let msg =
      raw.includes("Executable doesn't exist") || raw.includes("browserType.launchPersistentContext")
        ? `${raw} — First run: pnpm --filter @gdms/automation-service exec playwright install chromium`
        : raw;
    if (msg.includes("browserType.launch")) {
      msg = `${msg} (Playwright/Chromium launch failed — install browser binaries)`;
    }

    const pauseInsteadOfFail =
      payload.operation === "enquiry_transfer" &&
      !stopped &&
      shouldKeepBrowserOnFailure();

    if (!pausedUser) {
      await prisma.workflowRun.update({
        where: { id: payload.runId },
        data: {
          status: stopped ? "STOPPED" : pauseInsteadOfFail ? "PAUSED_USER" : "FAILED",
          endedAt: new Date(),
          errorMessage: pauseInsteadOfFail
            ? "Automation paused — use Resume on Live session when GDMS is ready."
            : msg,
        },
      });
      if (!stopped && pauseInsteadOfFail) {
        await publish(redisClient, SocketEvents.WORKFLOW_PAUSED_USER, payload.dealerId, {
          workflowRunId: payload.runId,
          message: msg,
        });
      } else if (!stopped) {
        await publish(redisClient, SocketEvents.WORKFLOW_FAILED, payload.dealerId, {
          workflowRunId: payload.runId,
          error: msg,
        });
      }
    }

    if (pausedUser) {
      await log("warn", msg);
    } else {
      await log("error", msg);
    }

    const keepBrowser =
      !stopped &&
      context &&
      page &&
      ((pausedUser && payload.operation === "enquiry_transfer") ||
        (!pausedUser &&
          shouldKeepBrowserOnFailure() &&
          (payload.operation === "enquiry_transfer" || payload.kind === "gdms_login")));

    if (keepBrowser && page && context) {
      browserRetained = true;
      const activePage = page;
      const activeContext = context;
      const stopScreenshots = (): void => {
        if (shotLoop) {
          clearInterval(shotLoop);
          shotLoop = null;
        }
      };
      if (!getActiveSession(payload.runId)) {
        registerActiveSession({
          runId: payload.runId,
          dealerId: payload.dealerId,
          page: activePage,
          context: activeContext,
          payload,
          captureFrame,
          stopScreenshots,
        });
      }
      const enquiryPaused =
        payload.operation === "enquiry_transfer" &&
        (pausedUser || pauseInsteadOfFail);
      if (enquiryPaused) {
        await log(
          "info",
          "Browser kept open — use Resume saved session or Retry transfer on Live session when GDMS is ready.",
        );
      } else {
        await log(
          "info",
          "Browser kept open — finish login in the preview, then use Retry transfer on the live session page.",
        );
        const endReason = await watchGdmsSession({
          page: activePage,
          context: activeContext,
          runId: payload.runId,
          baseUrl: env.GDMS_BASE_URL,
          redis: redisClient,
          log,
          publish: (type, p) => publish(redisClient, type, payload.dealerId, p),
          shouldStop: () => isStopped(redisClient, payload.runId),
        });
        unregisterActiveSession(payload.runId);
        browserRetained = false;
        if (endReason === "stopped") {
          await prisma.workflowRun.update({
            where: { id: payload.runId },
            data: { status: "STOPPED", endedAt: new Date() },
          });
        }
      }
    }
  } finally {
    if (!browserRetained) {
      detachInputGuard?.();
      unregisterActiveSession(payload.runId);
      if (shotLoop) clearInterval(shotLoop);
      if (context) await context.close().catch(() => undefined);
    }
    redisClient.disconnect();
  }
}

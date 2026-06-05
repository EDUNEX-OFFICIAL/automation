import { Redis } from "ioredis";
import type { BrowserContext, Page } from "playwright";
import path from "node:path";
import { createPrisma } from "@gdms/database";
import {
  SocketEvents,
  WORKFLOW_REDIS_CHANNEL,
  RUN_LOG_BUFFER_MAX_LINES,
  runLogBufferKey,
  type LogLinePayload,
  type ScreenshotFramePayload,
} from "@gdms/shared";
import type { WorkflowDefinition, WorkflowStep } from "@gdms/workflow-engine";
import { ingestInquiriesFromPage } from "./ingest-inquiries.js";
import {
  ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE,
  runEnquiryTransfer,
} from "./enquiry-transfer.js";
import { displayForUserOperation, gdmsBootstrapRedisKey, resolveGdmsHomeUrl } from "@gdms/shared";
import { applyGdmsBootstrapCookies } from "./gdms-cookie-bootstrap.js";
import { humanDelay } from "./human-delay.js";
import { assertEnquiryTransferBrowserMode } from "./browser-context.js";
import { launchGdmsPersistentContext } from "./browser-profile.js";
import { startGdmsBrowserWindowTitleRefresh } from "./gdms-browser-window-title.js";
import { startGdmsBrowserWindowGeometryRefresh } from "./gdms-browser-window-geometry.js";
import { env } from "./config.js";
import { detectGdmsLoginError, gdmsLoginErrorMessage } from "./gdms-login-errors.js";
import {
  isGdmsDashboardReady,
  isGdmsLoggedIn,
  redisControlKey,
  waitForGdmsDashboardReady,
  touchWatchHeartbeat,
  watchGdmsSession,
} from "./gdms-session-watch.js";
import {
  attachInputGuardListeners,
  attachNonFatalNetworkLogging,
  installAutomationBrowserScripts,
} from "./automation-browser-setup.js";
import {
  browserProfileKeyForOperation,
  closeActiveSessionsForDealer,
  getActiveSession,
  registerActiveSession,
  unregisterActiveSession,
} from "./active-sessions.js";
import { runFollowUpSkip } from "./follow-up-skip.js";
import { loadDealerRemarkConfig } from "./dealer-remark-config.js";
import { registerOtpWake } from "./otp-wake.js";

const prisma = createPrisma();

function shouldKeepBrowserOnFailure(): boolean {
  if (env.GDMS_KEEP_BROWSER_ON_FAILURE !== undefined) {
    return env.GDMS_KEEP_BROWSER_ON_FAILURE;
  }
  return env.PLAYWRIGHT_HEADED;
}

function isTransientRuntimeError(raw: string): boolean {
  const s = raw.toLowerCase();
  return (
    /timeout|timed out|network|econnreset|econnrefused|net::err|request failed|socket hang up|target closed|navigation failed|err_connection|fetch failed/i.test(
      s,
    ) || s.includes("profile appears to be in use")
  );
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

function otpReadyChannel(runId: string): string {
  return `run:${runId}:otp_ready`;
}

async function readOtpFromRedis(redis: Redis, runId: string): Promise<string | null> {
  try {
    const otp = await redis.get(`run:${runId}:otp`);
    if (!otp) return null;
    const gate = await redis.get(`run:${runId}:otp_gate`);
    const at = await redis.get(`run:${runId}:otp_at`);
    if (gate && at) {
      if (Number(at) < Number(gate)) return null;
      return otp;
    }
    if (gate && !at) return null;
    return otp;
  } catch {
    return null;
  }
}

/** Waits for dashboard OTP submit (Redis key + pub/sub wake). Poll-only was unreliable on long Docker runs. */
async function waitForOtp(redis: Redis, runId: string, timeoutMs: number): Promise<string> {
  const existing = await readOtpFromRedis(redis, runId);
  if (existing) return existing;

  const subscriber = redis.duplicate();
  await subscriber.subscribe(otpReadyChannel(runId));

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      subscriber.removeAllListeners("message");
      void subscriber.unsubscribe(otpReadyChannel(runId)).catch(() => undefined);
      void subscriber.quit().catch(() => undefined);
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      unregisterWake();
      fn();
    };

    const tryResolve = async (): Promise<void> => {
      if (await isStopped(redis, runId)) {
        finish(() => reject(new Error("stopped")));
        return;
      }
      const v = await readOtpFromRedis(redis, runId);
      if (v) finish(() => resolve(v));
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("OTP timeout")));
    }, timeoutMs);

    const unregisterWake = registerOtpWake(runId, () => {
      void tryResolve();
    });

    subscriber.on("message", () => {
      void tryResolve();
    });

    void (async () => {
      while (!settled) {
        await tryResolve();
        if (settled) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  });
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
  startedByUserId: string;
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
    if (step.id === "send_otp" && creds.gdmsPassword) {
      const passField = page.getByPlaceholder(/password/i).first();
      if (await passField.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const current = (await passField.inputValue().catch(() => "")).trim();
        if (!current) {
          await passField.fill(creds.gdmsPassword, { timeout });
          await humanDelay(200, 400);
        }
      }
    }
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
    if (await isGdmsDashboardReady(page)) {
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: "RUNNING" },
      });
      return;
    }
    const detected = await detectGdmsLoginError(page, 1500);
    if (detected) throw new Error(gdmsLoginErrorMessage(detected));
    const gate = String(Date.now());
    await redisClient.set(`run:${runId}:otp_gate`, gate, "EX", 3600);
    await redisClient.del(`run:${runId}:otp`);
    await redisClient.del(`run:${runId}:otp_at`);
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
  let aliveLoop: ReturnType<typeof setInterval> | null = null;
  let context: BrowserContext | null = null;
  let shotLoop: ReturnType<typeof setInterval> | null = null;
  let stopTitleRefresh: (() => void) | null = null;
  let stopGeometryRefresh: (() => void) | null = null;
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
    try {
      await redisClient.lpush(runLogBufferKey(payload.runId), JSON.stringify(line));
      await redisClient.ltrim(runLogBufferKey(payload.runId), 0, RUN_LOG_BUFFER_MAX_LINES - 1);
      await redisClient.expire(runLogBufferKey(payload.runId), 86_400);
    } catch {
      /* ignore buffer errors */
    }
  };

  const baseCreds = {
    gdmsUsername: payload.gdmsUsername,
    gdmsPassword: payload.gdmsPassword,
  };

  const profileKey = browserProfileKeyForOperation(
    payload.dealerId,
    payload.operation,
    payload.startedByUserId,
  );
  const isEnquiryTransfer = payload.operation === "enquiry_transfer";
  const isFollowUpSkip = payload.operation === "follow_up_skip" || payload.operation === "follow_up";
  /** Enquiry transfer runs until Stop; Follow Up Skip exits when the list is empty. */
  const isLongRunningAutomation = isEnquiryTransfer;
  const isGdmsBrowserAutomation = isEnquiryTransfer || isFollowUpSkip;

  const startAliveHeartbeat = (): void => {
    if (aliveLoop) return;
    void touchWatchHeartbeat(redisClient, payload.runId);
    aliveLoop = setInterval(() => {
      void touchWatchHeartbeat(redisClient, payload.runId);
    }, 10_000);
  };

  try {
    startAliveHeartbeat();
    await prisma.workflowRun.update({
      where: { id: payload.runId },
      data: { status: "RUNNING", errorMessage: null },
    });

    await publish(redisClient, SocketEvents.WORKFLOW_STARTED, payload.dealerId, {
      workflowRunId: payload.runId,
      dealerId: payload.dealerId,
    });

    if (isGdmsBrowserAutomation) {
      assertEnquiryTransferBrowserMode();
    }

    const sessionDir = path.join(env.SESSIONS_DIR, profileKey);
    const vncDisplay = displayForUserOperation(payload.startedByUserId, payload.operation);
    await closeActiveSessionsForDealer(payload.dealerId, profileKey);
    context = await launchGdmsPersistentContext(sessionDir, { display: vncDisplay });
    if (isGdmsBrowserAutomation && vncDisplay) {
      stopTitleRefresh = startGdmsBrowserWindowTitleRefresh(vncDisplay, payload.operation);
      stopGeometryRefresh = startGdmsBrowserWindowGeometryRefresh(vncDisplay);
    }
    await log(
      "info",
      `GDMS browser for user ${payload.startedByUserId} on display ${vncDisplay} (${payload.operation}).`,
    );

    await installAutomationBrowserScripts(context);
    attachNonFatalNetworkLogging(context, (message) => {
      void log("warn", message);
    });

    const bootstrapCookiesApplied = await applyGdmsBootstrapCookies(
      context,
      sessionDir,
      payload.startedByUserId,
    );
    if (bootstrapCookiesApplied) {
      await log("info", "GDMS bootstrap cookies applied (saved token or env).");
    } else {
      const storedToken = await redisClient.get(gdmsBootstrapRedisKey(payload.startedByUserId));
      if (storedToken?.trim()) {
        await log(
          "warn",
          "Saved GDMS login token could not be applied — open Dashboard, paste a fresh BNES_JSESSIONID, then START again.",
        );
      }
    }

    page = await context.newPage();

    if (isGdmsBrowserAutomation) {
      detachInputGuard = attachInputGuardListeners(page);
      await log(
        "info",
        "GDMS browser input locked during automation — use Stop on Live session to interrupt.",
      );
    }

    /** JPEG preview on Live session when noVNC and/or explicit preview stream is enabled. */
    const screenshotsEnabled = env.GDMS_PREVIEW_STREAM === true || env.GDMS_REMOTE_VIEW === true;
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

    if (isGdmsBrowserAutomation && context && page) {
      browserRetained = true;
      registerActiveSession({
        runId: payload.runId,
        dealerId: payload.dealerId,
        startedByUserId: payload.startedByUserId,
        profileKey,
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

    const loginUrl =
      loginWorkflow.steps.find((s) => s.type === "navigate" && s.url)?.url ??
      env.GDMS_BASE_URL;
    const homeUrl = resolveGdmsHomeUrl(env.GDMS_HOME_URL);

    const firstNav = bootstrapCookiesApplied ? homeUrl : loginUrl;
    if (firstNav) {
      await page.goto(firstNav, { timeout: 60_000, waitUntil: "domcontentloaded" });
    }

    let skipLogin = isGdmsBrowserAutomation
      ? await isGdmsDashboardReady(page)
      : await isGdmsLoggedIn(page);

    if (!skipLogin && bootstrapCookiesApplied && homeUrl) {
      for (let attempt = 0; attempt < 4 && !skipLogin; attempt++) {
        await page.goto(homeUrl, { timeout: 90_000, waitUntil: "domcontentloaded" }).catch(() => undefined);
        await page.waitForTimeout(2000);
        skipLogin = isGdmsBrowserAutomation
          ? await isGdmsDashboardReady(page)
          : await isGdmsLoggedIn(page);
        if (skipLogin) break;
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        skipLogin = isGdmsBrowserAutomation
          ? await isGdmsDashboardReady(page)
          : await isGdmsLoggedIn(page);
      }
      if (skipLogin) {
        await log("info", "GDMS session restored from login token — login steps skipped.");
      }
    }

    if (!skipLogin && bootstrapCookiesApplied) {
      const msg =
        "Saved GDMS login token did not open a logged-in session (expired or wrong cookie). " +
        "Log in to GDMS in Chrome, copy a fresh BNES_JSESSIONID from DevTools → Application → Cookies, " +
        "save it on Dashboard → Use GDMS login token, then START again.";
      await log("error", msg);
      throw new Error(msg);
    }
    const stepGroups: { label: string; steps: WorkflowDefinition["steps"] }[] = [];
    if (skipLogin) {
      await log(
        "info",
        isGdmsBrowserAutomation
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

    const dealerRemarkConfig = await loadDealerRemarkConfig(payload.dealerId);

    if (payload.operation === "enquiry_transfer") {
      await log("info", "Starting enquiry transfer automation (runs until Stop).");
      await humanDelay(800, 1500);
      await runEnquiryTransfer({
        page,
        runId: payload.runId,
        dealerId: payload.dealerId,
        startedByUserId: payload.startedByUserId,
        redis: redisClient,
        sources: payload.sources,
        subSources: payload.subSources,
        remarkConfig: {
          defaultEnquiryRemarkBase: dealerRemarkConfig.defaultEnquiryRemarkBase,
          enquiryRemarkRules: dealerRemarkConfig.enquiryRemarkRules,
        },
        log,
        shouldStop: runCtx.shouldStop,
        waitIfPaused: runCtx.waitIfPaused,
        signalManualIntervention,
      });
      await humanDelay(500, 1200);
    }

    if (isFollowUpSkip) {
      await log("info", "Starting Follow Up Skip (Today's Follow Up) — stops when list is empty.");
      await humanDelay(800, 1500);
      await runFollowUpSkip({
        page,
        runId: payload.runId,
        dealerId: payload.dealerId,
        redis: redisClient,
        followUpSkipRemarkBases: dealerRemarkConfig.followUpSkipRemarkBases,
        log,
        shouldStop: runCtx.shouldStop,
        waitIfPaused: runCtx.waitIfPaused,
        signalManualIntervention,
      });
      await log("info", "Follow Up Skip complete — closing browser and marking run finished.");
      await prisma.workflowRun.update({
        where: { id: payload.runId },
        data: { status: "COMPLETED", endedAt: new Date(), currentStep: "completed" },
      });
      await publish(redisClient, SocketEvents.WORKFLOW_COMPLETED, payload.dealerId, {
        workflowRunId: payload.runId,
      });
      await humanDelay(500, 1200);
    }

    if (payload.kind === "inquiry_fetch") {
      await ingestInquiriesFromPage(page, payload.dealerId, redisClient, prisma, log);
    }

    const longRunningOp = isEnquiryTransfer;

    if (!longRunningOp && !isFollowUpSkip) {
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
      !longRunningOp &&
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
      isLongRunningAutomation &&
      !stopped &&
      (shouldKeepBrowserOnFailure() || isTransientRuntimeError(raw));

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
      ((pausedUser && isLongRunningAutomation) ||
        (!pausedUser &&
          (pauseInsteadOfFail ||
            (shouldKeepBrowserOnFailure() &&
              (isLongRunningAutomation || payload.kind === "gdms_login")))));

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
          startedByUserId: payload.startedByUserId,
          profileKey,
          page: activePage,
          context: activeContext,
          payload,
          captureFrame,
          stopScreenshots,
        });
      }
      const enquiryPaused = isLongRunningAutomation && (pausedUser || pauseInsteadOfFail);
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
    if (aliveLoop) {
      clearInterval(aliveLoop);
      aliveLoop = null;
    }
    stopTitleRefresh?.();
    stopTitleRefresh = null;
    stopGeometryRefresh?.();
    stopGeometryRefresh = null;
    if (!browserRetained) {
      detachInputGuard?.();
      unregisterActiveSession(payload.runId);
      if (shotLoop) clearInterval(shotLoop);
      if (context) await context.close().catch(() => undefined);
    }
    redisClient.disconnect();
  }
}

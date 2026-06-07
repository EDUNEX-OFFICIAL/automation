import type { Redis } from "ioredis";
import type { BrowserContext, Frame, Locator, Page } from "playwright";
import { SocketEvents, type LogLinePayload } from "@gdms/shared";
import { GDMS_SELECTOR_ENV } from "@gdms/workflow-engine";
import {
  clickDomCandidate,
  dumpGdmsSidebarDom,
  formatDomCandidateBrief,
  logTopDomCandidates,
  rankDomCandidates,
  writeDomDumpFile,
} from "./gdms-dom-discovery.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";
import { setAutomationInputBypass } from "./automation-browser-setup.js";
import { humanCarIconClick, humanDelay, humanHoverClick, pollDelay } from "./human-delay.js";
import { persistLastActiveRun } from "./last-active-run.js";

const DEFAULT_TIMEOUT_PATTERNS = [
  "session timeout",
  "session expired",
  "session has expired",
  "your session has timed out",
];

const WATCH_POLL_MS = 2500;

export function redisControlKey(
  runId: string,
  kind: "pause" | "stop" | "logout" | "resume-transfer",
): string {
  return `run:${runId}:control:${kind}`;
}

export async function setResumeTransferRequest(redis: Redis, runId: string): Promise<void> {
  await redis.set(redisControlKey(runId, "resume-transfer"), "1", "EX", 86400);
}

export async function clearResumeTransferRequest(redis: Redis, runId: string): Promise<void> {
  await redis.set(redisControlKey(runId, "resume-transfer"), "0", "EX", 86400);
}

export async function isResumeTransferRequested(redis: Redis, runId: string): Promise<boolean> {
  return (await redis.get(redisControlKey(runId, "resume-transfer"))) === "1";
}

export function redisTransferLockKey(runId: string): string {
  return `run:${runId}:enquiry-transfer-lock`;
}

/** Prevents duplicate runEnquiryTransfer loops on the same run. */
export async function tryAcquireTransferLock(redis: Redis, runId: string): Promise<boolean> {
  const acquired = await redis.set(redisTransferLockKey(runId), "1", "EX", 7200, "NX");
  return acquired === "OK";
}

export async function releaseTransferLock(redis: Redis, runId: string): Promise<void> {
  await redis.del(redisTransferLockKey(runId));
}

export function redisWatchHeartbeatKey(runId: string): string {
  return `run:${runId}:watch:heartbeat`;
}

export async function touchWatchHeartbeat(redis: Redis, runId: string): Promise<void> {
  await redis.set(redisWatchHeartbeatKey(runId), String(Date.now()), "EX", 120);
}

export async function isLogoutRequested(redis: Redis, runId: string): Promise<boolean> {
  const v = await redis.get(redisControlKey(runId, "logout"));
  return v === "1";
}

export async function clearLogoutRequest(redis: Redis, runId: string): Promise<void> {
  await redis.set(redisControlKey(runId, "logout"), "0", "EX", 86400);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function clickPwButton(page: Page, name: string): Promise<void> {
  const re = new RegExp(escapeRegExp(name), "i");
  let locator = page.getByRole("button", { name: re }).first();
  try {
    await locator.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    try {
      locator = page.getByRole("link", { name: re }).first();
      await locator.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      locator = page.getByText(re).first();
      await locator.waitFor({ state: "visible", timeout: 12_000 });
    }
  }
  await locator.click({ timeout: 12_000 });
}

function timeoutPatterns(): string[] {
  const raw = process.env.GDMS_SESSION_TIMEOUT_PATTERNS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_PATTERNS;
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function loginUserSelector(): string {
  return process.env.GDMS_SEL_LOGIN_USER ?? "pw:ph|User ID";
}

function loginPassSelector(): string {
  return process.env.GDMS_SEL_LOGIN_PASS ?? "pw:ph|Password";
}

async function isOnLoginUrl(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  return /login|selectlogin|signin|sign-in/.test(url);
}

async function isLoginFormVisible(page: Page): Promise<boolean> {
  if (!(await isOnLoginUrl(page))) return false;
  const userSel = loginUserSelector();
  const passSel = loginPassSelector();
  const checks: Array<() => Promise<boolean>> = [];

  const userPw = parsePwLocator(userSel);
  if (userPw?.kind === "placeholder") {
    checks.push(async () => {
      const loc = page.getByPlaceholder(new RegExp(escapeRegExp(userPw.text), "i")).first();
      return loc.isVisible({ timeout: 3_000 }).catch(() => false);
    });
  }

  const passPw = parsePwLocator(passSel);
  if (passPw?.kind === "placeholder") {
    checks.push(async () => {
      const loc = page.getByPlaceholder(new RegExp(escapeRegExp(passPw.text), "i")).first();
      return loc.isVisible({ timeout: 3_000 }).catch(() => false);
    });
  }

  if (checks.length === 0) {
    checks.push(async () =>
      page.locator('input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false),
    );
  }

  for (const check of checks) {
    if (await check()) return true;
  }
  return false;
}

/**
 * GDMS returns a bare JS redirect when the session is invalid. With
 * `X-Content-Type-Options: nosniff` and no Content-Type, Chromium shows that
 * script as plain text instead of executing it — login form never appears.
 */
export async function isGdmsRedirectScriptPage(page: Page): Promise<boolean> {
  try {
    const body = (await page.locator("body").innerText({ timeout: 3_000 }))
      .slice(0, 4_000)
      .toLowerCase();
    if (!body.includes("location.href")) return false;
    return (
      /window\.(top|self|opener)\.location\.href/.test(body) ||
      (/window\.location\.href/.test(body) && /login|selectlogin/.test(body))
    );
  } catch {
    return false;
  }
}

/** True when persistent session appears authenticated (no login form, no session-expired copy). */
export async function isGdmsLoggedIn(page: Page): Promise<boolean> {
  if (await isGdmsSessionExpired(page)) return false;
  if (await isLoginFormVisible(page)) return false;
  return true;
}

export async function isGdmsSessionExpired(page: Page): Promise<boolean> {
  if (await isGdmsRedirectScriptPage(page)) return true;
  const patterns = timeoutPatterns();
  let title = "";
  let body = "";
  try {
    title = (await page.title()).toLowerCase();
    body = (await page.locator("body").innerText({ timeout: 5_000 }))
      .slice(0, 8_000)
      .toLowerCase();
  } catch {
    return false;
  }
  const haystack = `${title}\n${body}`;
  return patterns.some((p) => haystack.includes(p));
}

export async function redirectToGdmsLogin(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  await context.clearCookies();
  const openLogin = async (): Promise<void> => {
    await page.goto(baseUrl, { timeout: 60_000, waitUntil: "load" });
  };
  await openLogin();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isLoginFormVisible(page)) return;
    if (!(await isGdmsRedirectScriptPage(page))) return;
    await openLogin();
    await page.waitForTimeout(400);
  }
}

/** No `[class*="left"]` — matches hidden `irx_progressStr_left` on selectMain loader. */
const SIDEBAR_CONTAINERS =
  'nav, aside, [class*="sidebar"], [class*="sidenav"], [class*="gnb"], [class*="menu"]';
const RAIL_SVG =
  "button:has(svg), a:has(svg), button:has(img), a:has(img), [role='button']:has(svg), [role='button']:has(img)";
const RAIL_BROAD = "button, a, [role='button'], li, [onclick], [class*='icon']";
const MIN_UI_HOME_SCORE = 8;
/** HMIL GDMS 2.0 sales/car icon — exact class nav_sal (not nav_sal_mis). */
const CAR_NAV_SAL_SELECTOR = "li.nav_sal, .nav_sal";
const CAR_NAV_SAL_TITLE_SELECTOR =
  'li.nav_sal[title*="Sale" i], li.nav_sal[title*="Sales" i]';
const DASHBOARD_POLL_MS = 1500;
const DASHBOARD_READY_ERROR =
  "GDMS dashboard did not load after login — complete OTP and login manually, then use Retry transfer.";

/** Page or child frame where GDMS home UI (sidebar, Notice) actually renders. */
export type GdmsUiRoot = Page | Frame;

const gdmsUiRootCache = new WeakMap<Page, GdmsUiRoot>();

export function clearGdmsUiRootCache(page: Page): void {
  gdmsUiRootCache.delete(page);
}

async function uiBodySnippet(ui: GdmsUiRoot): Promise<string> {
  try {
    return (await ui.locator("body").innerText({ timeout: 5_000 })).slice(0, 8_000).toLowerCase();
  } catch {
    return "";
  }
}

async function hasNoticePanelStructure(ui: GdmsUiRoot): Promise<boolean> {
  const notice = ui.getByText(/^Notice$/i).first();
  if (!(await notice.isVisible({ timeout: 1_200 }).catch(() => false))) return false;
  const panel = notice.locator(
    'xpath=ancestor::table[1] | ancestor::*[contains(@class,"grid") or contains(@class,"panel")][1]',
  );
  return panel.first().isVisible({ timeout: 800 }).catch(() => false);
}

/** True only when home panels/icons are visibly on screen (not loader body text). */
async function uiLooksLikeGdmsHome(ui: GdmsUiRoot): Promise<boolean> {
  const branding = await ui
    .getByText(/GDMS\s*2\.0/i)
    .first()
    .isVisible({ timeout: 1_200 })
    .catch(() => false);
  if (branding) return true;

  const notice = await ui
    .getByText(/^Notice$/i)
    .first()
    .isVisible({ timeout: 1_200 })
    .catch(() => false);
  if (notice && (await hasNoticePanelStructure(ui))) return true;

  const commonMsg = await ui
    .getByText(/Common Message/i)
    .first()
    .isVisible({ timeout: 1_200 })
    .catch(() => false);
  return commonMsg;
}

function uiContextUrl(ui: GdmsUiRoot): string {
  try {
    return ui.url().toLowerCase();
  } catch {
    return "";
  }
}

async function scoreUiContext(ui: GdmsUiRoot): Promise<number> {
  let score = 0;
  const url = uiContextUrl(ui);
  if (url.includes("selecthome")) score += 5;
  if (url.includes("selectmain")) score -= 5;

  if (
    await ui
      .getByText(/GDMS\s*2\.0/i)
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false)
  ) {
    score += 10;
  }
  if (
    await ui
      .getByText(/^Notice$/i)
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false)
  ) {
    score += 8;
  }
  if (
    await ui
      .getByText(/Common Message/i)
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false)
  ) {
    score += 8;
  }

  const visibleRails = await collectVisibleRailClickables(ui);
  score += visibleRails.length;
  return score;
}

function listUiCandidates(page: Page): GdmsUiRoot[] {
  const candidates: GdmsUiRoot[] = [page];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (!frame.isDetached()) candidates.push(frame);
    } catch {
      /* skip */
    }
  }
  return candidates;
}

async function anyContextLooksLikeGdmsHome(page: Page): Promise<boolean> {
  for (const ui of listUiCandidates(page)) {
    if (await uiLooksLikeGdmsHome(ui)) return true;
  }
  return false;
}

export type ResolvedGdmsUi = { ui: GdmsUiRoot; score: number };

/** Pick page or frame with highest home score (selectHome over selectMain loader). */
export async function resolveGdmsUiRootScored(page: Page): Promise<ResolvedGdmsUi> {
  let best: GdmsUiRoot = page;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const ui of listUiCandidates(page)) {
    const score = await scoreUiContext(ui);
    if (score > bestScore) {
      bestScore = score;
      best = ui;
    }
  }
  if (bestScore < MIN_UI_HOME_SCORE) {
    return { ui: page, score: bestScore };
  }
  return { ui: best, score: bestScore };
}

/** Resolve the DOM context (main page or iframe) that contains GDMS 2.0 home UI. */
export async function resolveGdmsUiRoot(page: Page): Promise<GdmsUiRoot> {
  const cached = gdmsUiRootCache.get(page);
  if (cached) {
    const detached = "isDetached" in cached && (cached as Frame).isDetached();
    if (!detached) return cached;
  }

  const { ui, score } = await resolveGdmsUiRootScored(page);
  if (score >= MIN_UI_HOME_SCORE) {
    gdmsUiRootCache.set(page, ui);
    return ui;
  }

  gdmsUiRootCache.set(page, page);
  return page;
}

export function gdmsUiFrameLabel(ui: GdmsUiRoot): string {
  try {
    return ui.url() || ("mainFrame" in ui ? "main" : "child-frame");
  } catch {
    return "mainFrame" in ui ? "main" : "child-frame";
  }
}

function railLocatorCandidates(ui: GdmsUiRoot): Locator[] {
  const containers = ui.locator(SIDEBAR_CONTAINERS);
  return [
    containers.locator(RAIL_SVG),
    containers.locator(RAIL_BROAD),
    ui.locator('[class*="gnb"], [class*="sidenav"], [class*="sidebar"]').locator(RAIL_BROAD),
  ];
}

/** Visible sidebar icons only (no hidden progress labels). */
export async function collectVisibleRailClickables(ui: GdmsUiRoot): Promise<Locator[]> {
  const items: Locator[] = [];
  for (const rail of railLocatorCandidates(ui)) {
    const n = Math.min(await rail.count(), 32);
    for (let i = 0; i < n; i++) {
      const el = rail.nth(i);
      if (await el.isVisible().catch(() => false)) items.push(el);
    }
  }
  return items;
}

export function gdmsSidebar(ui: GdmsUiRoot): Locator {
  return ui.locator(SIDEBAR_CONTAINERS);
}

/** Icon rail: svg/img controls inside sidebar containers. */
export function gdmsIconRail(ui: GdmsUiRoot): Locator {
  return ui.locator(SIDEBAR_CONTAINERS).locator(RAIL_SVG);
}

/** Broader rail clickables (CSS icons without svg/img). */
export function gdmsIconRailBroad(ui: GdmsUiRoot): Locator {
  return ui.locator(SIDEBAR_CONTAINERS).locator(RAIL_BROAD);
}

async function pageBodySnippet(page: Page): Promise<string> {
  return uiBodySnippet(page);
}

async function isOtpPendingOnLoginPage(page: Page): Promise<boolean> {
  if (!(await isLoginFormVisible(page))) return false;
  const body = await pageBodySnippet(page);
  return (
    body.includes("otp successfully sent") ||
    body.includes("enter otp") ||
    body.includes("send otp")
  );
}

async function hasSelectHomeUrl(page: Page): Promise<boolean> {
  return page.url().toLowerCase().includes("selecthome");
}

/** Strong home URL; selectMain alone is a weak loader shell signal. */
async function hasDashboardUrl(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (url.includes("selecthome")) return true;
  if (url.includes("selectmain")) return false;
  if (url.includes("cmmd/") && !/login|selectlogin|signin/.test(url)) return true;
  if (/hmil\.net/i.test(url) && /\.(dms|cms)/i.test(url) && !/login|selectlogin|signin/.test(url)) {
    return true;
  }
  if (/\.dms\//i.test(url) && !/login|selectlogin|signin/.test(url)) return true;
  return false;
}

async function hasGdmsHomeSignalsOnUi(ui: GdmsUiRoot): Promise<boolean> {
  if (await uiLooksLikeGdmsHome(ui)) return true;
  if (
    await ui
      .getByText(/Sales Customer Enquiry|Customer Enquiry Mgt/i)
      .first()
      .isVisible({ timeout: 1_200 })
      .catch(() => false)
  ) {
    return true;
  }
  return false;
}

async function hasGdmsHomeSignals(page: Page): Promise<boolean> {
  if (await anyContextLooksLikeGdmsHome(page)) return true;
  for (const ui of listUiCandidates(page)) {
    if (await hasGdmsHomeSignalsOnUi(ui)) return true;
  }
  return flyoutShowsCustomerEnquiryMgt(page);
}

async function countVisibleIconRailButtons(page: Page): Promise<number> {
  const ui = await resolveGdmsUiRoot(page);
  return (await collectVisibleRailClickables(ui)).length;
}

/** Strict: GDMS 2.0 branding + several sidebar icons (legacy check). */
async function isGdmsDashboardReadyStrict(page: Page): Promise<boolean> {
  if (await isGdmsSessionExpired(page)) return false;
  if (await isLoginFormVisible(page)) return false;
  if (await isOtpPendingOnLoginPage(page)) return false;
  if (!(await hasDashboardUrl(page))) return false;
  const ui = await resolveGdmsUiRoot(page);
  const branding = await ui
    .getByText(/GDMS\s*2\.0/i)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
  if (!branding) return false;
  return (await countVisibleIconRailButtons(page)) >= 3;
}

/** Relaxed: visible home panels or scored UI with enough rail icons — not selectMain body text alone. */
async function isGdmsDashboardReadyRelaxed(page: Page): Promise<boolean> {
  if (await isGdmsSessionExpired(page)) return false;
  if (await isOnLoginUrl(page)) return false;
  if (await isOtpPendingOnLoginPage(page)) return false;
  if (await isLoginFormVisible(page)) return false;

  if (await anyContextLooksLikeGdmsHome(page)) return true;

  const { ui, score } = await resolveGdmsUiRootScored(page);
  const iconCount = (await collectVisibleRailClickables(ui)).length;
  if (iconCount >= 2 && score >= MIN_UI_HOME_SCORE) return true;

  if ((await hasSelectHomeUrl(page)) && iconCount >= 1) return true;
  if ((await hasDashboardUrl(page)) && (await hasGdmsHomeSignals(page)) && iconCount >= 2) {
    return true;
  }
  return false;
}

export async function isGdmsDashboardReady(page: Page): Promise<boolean> {
  if (await isGdmsDashboardReadyStrict(page)) return true;
  return isGdmsDashboardReadyRelaxed(page);
}

export async function isOnCustomerEnquiryList(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  const contexts: GdmsUiRoot[] = [ui, page];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }
  for (const ctx of contexts) {
    if (
      await ctx
        .getByText(/Sales Customer Enquiry/i)
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

/** Reuse profile tab on enquiry list / dashboard — avoid extra `newPage()` that opens home. */
export async function pickGdmsWorkPage(context: BrowserContext): Promise<Page> {
  const open = context.pages().filter((p) => !p.isClosed());
  for (const p of open) {
    if (await isOnCustomerEnquiryList(p)) return p;
  }
  for (const p of open) {
    if (await isGdmsDashboardReady(p)) return p;
  }
  if (open.length > 0) return open[open.length - 1]!;
  return context.newPage();
}

async function describeDashboardBlockers(page: Page): Promise<string> {
  const parts: string[] = [];
  if (await isGdmsSessionExpired(page)) parts.push("session expired");
  if (await isOnLoginUrl(page)) parts.push("still on login URL");
  if (await isOtpPendingOnLoginPage(page)) parts.push("OTP step pending");
  if (await isLoginFormVisible(page)) parts.push("login form visible");
  if (!(await hasDashboardUrl(page))) parts.push("home URL not detected");

  const ui = await resolveGdmsUiRoot(page);
  const frameLabel = gdmsUiFrameLabel(ui);
  parts.push(`ui=${frameLabel}`);

  const notice = await ui
    .getByText(/^Notice$/i)
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
  const gdmsBrand = await ui
    .getByText(/GDMS\s*2\.0/i)
    .first()
    .isVisible({ timeout: 800 })
    .catch(() => false);
  parts.push(`notice=${notice ? "yes" : "no"}`);
  parts.push(`gdms2=${gdmsBrand ? "yes" : "no"}`);

  const icons = await countVisibleIconRailButtons(page);
  parts.push(`${icons} sidebar icon(s) visible`);
  parts.push(`frames=${page.frames().length}`);
  return parts.length ? parts.join("; ") : "checking…";
}

export type DashboardWaitOptions = {
  redis?: Redis;
  runId?: string;
  dealerId?: string;
  shouldStop?: () => Promise<boolean>;
};

const DEALER_GDMS_AUTH_TTL_SEC = 7 * 86_400;

export async function markDealerGdmsAuthenticated(
  redis: Redis,
  dealerId: string,
  runId: string,
): Promise<void> {
  await redis.set(`dealer:${dealerId}:gdms_authenticated`, runId, "EX", DEALER_GDMS_AUTH_TTL_SEC);
  await redis.set(`dealer:${dealerId}:last_run_id`, runId, "EX", DEALER_GDMS_AUTH_TTL_SEC);
}

async function tryNavigateToGdmsHomeTab(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase();
  if (!url.includes("selectmain")) return false;
  const home = page
    .getByRole("link", { name: /^home$/i })
    .or(page.getByRole("tab", { name: /^home$/i }))
    .or(page.getByText(/^Home$/i).first());
  if (!(await home.first().isVisible({ timeout: 2_000 }).catch(() => false))) return false;
  await home.first().click({ timeout: 12_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  return true;
}

export async function waitForGdmsDashboardReady(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  timeoutMs = 120_000,
  opts?: DashboardWaitOptions,
): Promise<void> {
  await log("info", "Waiting for GDMS dashboard.");
  clearGdmsUiRootCache(page);
  const deadline = Date.now() + timeoutMs;
  let lastStatusLog = 0;
  let resumeWaitLogged = false;
  let selectMainSince = 0;
  let homeTabClicked = false;
  while (Date.now() < deadline) {
    if (opts?.shouldStop && (await opts.shouldStop())) throw new Error("stopped");

    if (page.url().toLowerCase().includes("selectmain")) {
      if (!selectMainSince) selectMainSince = Date.now();
      if (!homeTabClicked && Date.now() - selectMainSince > 5_000) {
        homeTabClicked = true;
        if (await tryNavigateToGdmsHomeTab(page)) {
          clearGdmsUiRootCache(page);
          await log("info", "Opened Home tab from selectMain shell.");
        }
      }
    } else {
      selectMainSince = 0;
    }

    if (await isGdmsDashboardReady(page)) {
      clearGdmsUiRootCache(page);
      const { ui, score } = await resolveGdmsUiRootScored(page);
      gdmsUiRootCache.set(page, ui);
      await log("info", `GDMS dashboard is ready (ui=${gdmsUiFrameLabel(ui)} score=${score}).`);
      try {
        const domCandidates = await dumpGdmsSidebarDom(ui);
        await logTopDomCandidates(domCandidates, log);
        await writeDomDumpFile(domCandidates, opts?.runId, "selectHome");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log("warn", `Sidebar DOM scan skipped: ${msg}`);
      }
      if (opts?.runId && opts?.dealerId) {
        try {
          await persistLastActiveRun({
            runId: opts.runId,
            dealerId: opts.dealerId,
            url: gdmsUiFrameLabel(ui),
          });
        } catch {
          /* non-fatal */
        }
      }
      if (opts?.redis && opts.runId) await clearResumeTransferRequest(opts.redis, opts.runId);
      if (opts?.redis && opts.dealerId && opts.runId) {
        await markDealerGdmsAuthenticated(opts.redis, opts.dealerId, opts.runId);
      }
      return;
    }

    if (opts?.redis && opts.runId && (await isResumeTransferRequested(opts.redis, opts.runId))) {
      if (!resumeWaitLogged) {
        resumeWaitLogged = true;
        await log("info", "Continue transfer — checking your open GDMS home screen.");
      }
      const canContinue =
        (await isGdmsDashboardReadyRelaxed(page)) ||
        ((await isGdmsLoggedIn(page)) && (await hasDashboardUrl(page)));
      if (canContinue) {
        await clearResumeTransferRequest(opts.redis, opts.runId);
        await log("info", "Continuing from your open GDMS session (home screen detected).");
        if (opts.dealerId && opts.runId) {
          await markDealerGdmsAuthenticated(opts.redis, opts.dealerId, opts.runId);
          try {
            await persistLastActiveRun({
              runId: opts.runId,
              dealerId: opts.dealerId,
              url: page.url(),
            });
          } catch {
            /* non-fatal */
          }
        }
        return;
      }
    }

    const now = Date.now();
    if (now - lastStatusLog >= 15_000) {
      lastStatusLog = now;
      clearGdmsUiRootCache(page);
      const blockers = await describeDashboardBlockers(page);
      await log("info", `Still waiting for dashboard — ${blockers}`);
    }

    await pollDelay(DASHBOARD_POLL_MS);
  }
  throw new Error(DASHBOARD_READY_ERROR);
}

export async function flyoutShowsCustomerEnquiryMgt(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  for (const ctx of [ui, page]) {
    if (
      await ctx
        .getByText(/Customer Enquiry Mgt/i)
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    if (
      await frame
        .getByText(/Customer Enquiry Mgt/i)
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

async function logSidebarContainerHints(
  ui: GdmsUiRoot,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<void> {
  const containers = ui.locator(SIDEBAR_CONTAINERS);
  const n = Math.min(await containers.count(), 6);
  const hints: string[] = [];
  for (let i = 0; i < n; i++) {
    const el = containers.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => "?");
    const cls = await el.getAttribute("class").catch(() => "");
    hints.push(`${tag}.${(cls ?? "").split(/\s+/).slice(0, 2).join(".")}`);
    if (hints.length >= 3) break;
  }
  if (hints.length) await log("warn", `Car sidebar: visible containers — ${hints.join(", ")}.`);
}

async function waitForFlyoutAfterCarClick(page: Page, maxMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await flyoutShowsCustomerEnquiryMgt(page)) return true;
    await pollDelay(450);
  }
  return false;
}

async function tryCarSidebarClickWithFlyoutProof(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  click: () => Promise<void>,
  successLog: string,
): Promise<boolean> {
  try {
    await click();
    if (await waitForFlyoutAfterCarClick(page)) {
      await log("info", successLog);
      return true;
    }
  } catch {
    /* try next */
  }
  return false;
}

async function waitForSalesSidebarReady(
  ui: GdmsUiRoot,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<Locator> {
  const sal = ui.locator(CAR_NAV_SAL_SELECTOR).first();
  await sal.waitFor({ state: "visible", timeout: 90_000 });
  await humanDelay(400, 900);
  await log("info", "Sales sidebar (nav_sal) visible — preparing hover and click.");
  return sal;
}

async function tryClickNavSalCarIcon(
  page: Page,
  ui: GdmsUiRoot,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<boolean> {
  const contexts: GdmsUiRoot[] = [ui];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }

  for (const ctx of contexts) {
    const candidates = [
      ctx.locator(CAR_NAV_SAL_SELECTOR).first(),
      ctx.locator(CAR_NAV_SAL_TITLE_SELECTOR).first(),
    ];
    for (const el of candidates) {
      if ((await el.count().catch(() => 0)) < 1) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      if (/\bnav_sal_mis\b/i.test((await el.getAttribute("class").catch(() => "")) ?? "")) {
        continue;
      }
      if (
        await tryCarSidebarClickWithFlyoutProof(
          page,
          log,
          () => humanCarIconClick(el),
          "Car sidebar: li.nav_sal opened flyout.",
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export type CarSidebarClickOpts = { runId?: string };

export async function clickCustomerEnquirySidebarIcon(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  opts?: CarSidebarClickOpts,
): Promise<void> {
  clearGdmsUiRootCache(page);
  const { ui, score } = await resolveGdmsUiRootScored(page);
  if (score >= MIN_UI_HOME_SCORE) gdmsUiRootCache.set(page, ui);
  await log("info", `Car sidebar: using ui=${gdmsUiFrameLabel(ui)} score=${score}.`);

  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await waitForSalesSidebarReady(ui, log);

  if (await tryClickNavSalCarIcon(page, ui, log)) return;

  const carSel = process.env.GDMS_SEL_CAR_SIDEBAR?.trim();
  if (carSel && !carSel.startsWith("pw:")) {
    const envLoc = ui.locator(carSel).first();
    if (
      await tryCarSidebarClickWithFlyoutProof(
        page,
        log,
        () => envLoc.click({ timeout: 20_000 }),
        "Car sidebar: GDMS_SEL_CAR_SIDEBAR (flyout ok).",
      )
    ) {
      return;
    }
  }

  const labelled = ui
    .locator(
      '[title*="Customer Enquiry" i], [aria-label*="Customer Enquiry" i], [title*="Enquiry Mgt" i], [aria-label*="Enquiry Mgt" i]',
    )
    .or(ui.getByRole("button", { name: /customer enquiry|enquiry mgt/i }));
  const labelledCount = await labelled.count();
  for (let i = 0; i < labelledCount; i++) {
    const el = labelled.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (
      await tryCarSidebarClickWithFlyoutProof(
        page,
        log,
        () => el.click({ timeout: 20_000 }),
        "Car sidebar: labelled control (flyout ok).",
      )
    ) {
      return;
    }
  }

  const domCandidates = await dumpGdmsSidebarDom(ui);
  await logTopDomCandidates(domCandidates, log);

  const ranked = rankDomCandidates(domCandidates)
    .filter((c) => c.domScore > -20)
    .filter((c) => /\bnav_sal\b/i.test(c.className) && !/\bnav_sal_mis\b/i.test(c.className));
  for (const c of ranked.slice(0, 3)) {
    if (
      await tryCarSidebarClickWithFlyoutProof(
        page,
        log,
        () => clickDomCandidate(ui, c),
        `Car sidebar: DOM pick ${formatDomCandidateBrief(c)} (flyout ok).`,
      )
    ) {
      return;
    }
  }

  await logTopDomCandidates(domCandidates, log, 5);
  await logSidebarContainerHints(ui, log);
  const dumpPath = await writeDomDumpFile(domCandidates, opts?.runId, "car-click-fail");
  if (dumpPath) await log("warn", `Car sidebar DOM dump written: ${dumpPath}`);
  await log(
    "error",
    "Could not open Customer Enquiry from li.nav_sal — fix GDMS manually, then press Resume on Live session.",
  );
  throw new Error(ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE);
}

function gdmsUiContexts(page: Page, ui?: GdmsUiRoot): GdmsUiRoot[] {
  const roots: GdmsUiRoot[] = ui ? [ui, page] : [page];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) roots.push(frame);
  }
  return roots;
}

/** Step 3 tree open — Lost Customer List / Enquiry Transfer, or visible menuItem (never .count()). */
export async function isCustomerEnquiryTreeExpanded(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  for (const ctx of gdmsUiContexts(page, ui)) {
    if (
      await ctx
        .getByText(/Lost Customer List/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false)
    ) {
      return true;
    }
    if (
      await ctx
        .getByText(/^Enquiry Transfer$/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false)
    ) {
      return true;
    }
    const item = ctx.locator('a.menuItem[data-title="Customer Enquiry"]').first();
    if (await item.isVisible({ timeout: 1_500 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/** Step 2 only: car flyout with Mgt / Booking / Order — user stuck screenshot. */
export async function isSalesFlyoutOnlyOpen(page: Page): Promise<boolean> {
  if (await isCustomerEnquiryTreeExpanded(page)) return false;
  return flyoutShowsCustomerEnquiryMgt(page);
}

export async function waitForCustomerEnquiryTreeExpanded(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  maxMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isCustomerEnquiryTreeExpanded(page)) {
      await log("info", "Customer Enquiry menu tree expanded.");
      return;
    }
    await pollDelay(500);
  }
  throw new Error("Customer Enquiry menu tree did not expand after Customer Enquiry Mgt");
}

/** Click the flyout link after li.nav_sal (step 2/3) — then wait for tree panel. */
export async function clickCustomerEnquiryFlyoutMgt(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<void> {
  const ui = await resolveGdmsUiRoot(page);
  const contexts = gdmsUiContexts(page, ui);

  await setAutomationInputBypass(page, true);
  try {
    for (const ctx of contexts) {
      const byText = ctx.getByText(/^Customer Enquiry Mgt$/i).first();
      if (await byText.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await byText.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
        await humanDelay(300, 700);
        await byText.click({ timeout: 30_000, force: true });
        await log("info", "Clicked Customer Enquiry Mgt flyout (step 2/3).");
        await waitForCustomerEnquiryTreeExpanded(page, log);
        return;
      }
    }

    for (const ctx of contexts) {
      const link = ctx
        .locator("a, span, div")
        .filter({ hasText: /^Customer Enquiry Mgt$/i })
        .first();
      if ((await link.count().catch(() => 0)) < 1) continue;
      await link.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
      await humanDelay(300, 700);
      await link.click({ timeout: 30_000, force: true });
      await log("info", "Clicked Customer Enquiry Mgt flyout (step 2/3, fallback).");
      await waitForCustomerEnquiryTreeExpanded(page, log);
      return;
    }

    throw new Error("Customer Enquiry Mgt flyout link not found");
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Left menu tree (not the narrow car-icon flyout strip). */
async function locatorInLeftMenuTree(loc: Locator): Promise<boolean> {
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;
  return box.x >= 55 && box.width < 400;
}

/** Today's Follow Up tree link visible (step 3 target). */
export async function isTodaysFollowUpMenuItemVisible(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  const selectors = [
    'a.menuItem[data-title*="Today\'s Follow Up"]',
    'a.menuItem[data-title*="Todays Follow Up"]',
    'a[data-title*="Today\'s Follow Up"]',
  ];
  for (const ctx of gdmsUiContexts(page, ui)) {
    for (const sel of selectors) {
      const link = ctx.locator(sel).first();
      if (await link.isVisible({ timeout: 2_000 }).catch(() => false)) return true;
    }
    const roleLink = ctx.getByRole("link", { name: /Today'?s\s*Follow\s*Up/i }).first();
    if (await roleLink.isVisible({ timeout: 2_000 }).catch(() => false)) return true;
  }
  return false;
}

/** Step 2 only: car flyout shows Booking/Retail Mgt but tree not expanded yet. */
export async function isBookingRetailFlyoutOnlyOpen(page: Page): Promise<boolean> {
  if (await isBookingRetailTreeExpanded(page)) return false;
  return flyoutShowsBookingRetailMgt(page);
}

export async function flyoutShowsBookingRetailMgt(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  for (const ctx of [ui, page]) {
    if (
      await ctx
        .getByText(/Booking\s*\/\s*Retail\s*Mgt/i)
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    if (
      await frame
        .getByText(/Booking\s*\/\s*Retail\s*Mgt/i)
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

async function waitForBookingFlyoutAfterCarClick(page: Page, maxMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await flyoutShowsBookingRetailMgt(page)) return true;
    await pollDelay(450);
  }
  return false;
}

async function tryCarSidebarClickWithBookingFlyoutProof(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  click: () => Promise<void>,
  successLog: string,
): Promise<boolean> {
  try {
    await click();
    if (await waitForBookingFlyoutAfterCarClick(page)) {
      await log("info", successLog);
      return true;
    }
  } catch {
    /* try next */
  }
  return false;
}

/** Car icon (li.nav_sal) — opens flyout with Booking/Retail Mgt (Today's Follow Up path). */
export async function clickSalesCarSidebarIconForBooking(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  _opts?: CarSidebarClickOpts,
): Promise<void> {
  clearGdmsUiRootCache(page);
  const { ui, score } = await resolveGdmsUiRootScored(page);
  if (score >= MIN_UI_HOME_SCORE) gdmsUiRootCache.set(page, ui);
  await log("info", `Car sidebar (booking path): ui=${gdmsUiFrameLabel(ui)} score=${score}.`);

  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await waitForSalesSidebarReady(ui, log);

  const contexts: GdmsUiRoot[] = [ui];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }

  for (const ctx of contexts) {
    const candidates = [
      ctx.locator(CAR_NAV_SAL_SELECTOR).first(),
      ctx.locator(CAR_NAV_SAL_TITLE_SELECTOR).first(),
    ];
    for (const el of candidates) {
      if ((await el.count().catch(() => 0)) < 1) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      if (/\bnav_sal_mis\b/i.test((await el.getAttribute("class").catch(() => "")) ?? "")) continue;
      if (
        await tryCarSidebarClickWithBookingFlyoutProof(
          page,
          log,
          () => humanCarIconClick(el),
          "Car sidebar: li.nav_sal opened Booking/Retail flyout.",
        )
      ) {
        return;
      }
    }
  }

  throw new Error("Could not open Booking/Retail Mgt flyout from car sidebar (li.nav_sal).");
}

async function findBookingRetailFlyoutLink(ctx: GdmsUiRoot): Promise<Locator | null> {
  const patterns = [
    ctx.locator("a").filter({ hasText: /^Booking\s*\/\s*Retail\s*Mgt$/i }).first(),
    ctx
      .locator("li")
      .filter({ hasText: /^Booking\s*\/\s*Retail\s*Mgt$/i })
      .locator("a")
      .first(),
    ctx.getByRole("link", { name: /^Booking\s*\/\s*Retail\s*Mgt$/i }).first(),
    ctx.getByText(/^Booking\s*\/\s*Retail\s*Mgt$/i).first(),
  ];
  for (const loc of patterns) {
    if ((await loc.count().catch(() => 0)) < 1) continue;
    if (!(await loc.isVisible({ timeout: 2_000 }).catch(() => false))) continue;
    const box = await loc.boundingBox().catch(() => null);
    if (box && box.x > 130) continue;
    return loc;
  }
  return null;
}

async function clickBookingRetailFlyoutLinkOnce(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  label: string,
): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  const contexts = gdmsUiContexts(page, ui);
  for (const ctx of contexts) {
    const link = await findBookingRetailFlyoutLink(ctx);
    if (!link) continue;
    await link.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
    await humanDelay(250, 600);
    try {
      await humanHoverClick(link);
    } catch {
      await link.click({ timeout: 30_000, force: true });
    }
    await log("info", label);
    return true;
  }
  return false;
}

export async function clickBookingRetailFlyoutMgt(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<void> {
  await setAutomationInputBypass(page, true);
  try {
    const clicked = await clickBookingRetailFlyoutLinkOnce(
      page,
      log,
      "Clicked Booking/Retail Mgt flyout (single click).",
    );
    if (!clicked) {
      throw new Error("Booking/Retail Mgt flyout link not found");
    }
    await humanDelay(700, 1_400);
    if (await isTodaysFollowUpMenuItemVisible(page)) {
      await log("info", "Today's Follow Up visible in menu tree after Booking/Retail Mgt.");
    } else if (await isBookingRetailTreeExpanded(page)) {
      await log("info", "Booking/Retail menu tree expanded.");
    }
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

export async function isBookingRetailTreeExpanded(page: Page): Promise<boolean> {
  if (await isTodaysFollowUpMenuItemVisible(page)) return true;
  const ui = await resolveGdmsUiRoot(page);
  for (const ctx of gdmsUiContexts(page, ui)) {
    const menuItems = ctx.locator("a.menuItem");
    const n = await menuItems.count().catch(() => 0);
    let inTree = 0;
    for (let i = 0; i < Math.min(n, 50); i++) {
      const item = menuItems.nth(i);
      if (!(await item.isVisible({ timeout: 200 }).catch(() => false))) continue;
      if (await locatorInLeftMenuTree(item)) inTree += 1;
    }
    if (inTree >= 3) return true;
  }
  return false;
}

export async function waitForBookingRetailTreeExpanded(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  maxMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isBookingRetailTreeExpanded(page)) {
      await log("info", "Booking/Retail menu tree expanded.");
      return;
    }
    await pollDelay(500);
  }
  throw new Error("Booking/Retail menu tree did not expand after Booking/Retail Mgt");
}

export async function clickTodaysFollowUpTreeItem(
  page: Page,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<void> {
  const ui = await resolveGdmsUiRoot(page);
  const contexts: GdmsUiRoot[] = [ui, page];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }

  const treeSelectors = [
    'a.menuItem[data-title*="Today\'s Follow Up"]',
    'a.menuItem[data-title*="Todays Follow Up"]',
    'a[data-title*="Today\'s Follow Up"]',
    'a[data-title*="Todays Follow Up"]',
    'a[href*="TodaysFollowUp" i]',
    'a[href*="todaysFollowUp" i]',
    'a[href*="FollowUp" i]',
  ];

  for (const ctx of contexts) {
    const byText = ctx.getByText(/^Today'?s\s*Follow\s*Up$/i).first();
    if (await byText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await byText.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
      await humanDelay(300, 700);
      try {
        await humanHoverClick(byText);
      } catch {
        await byText.click({ timeout: 9_000, force: true });
      }
      await log("info", "Clicked Today's Follow Up (text match).");
      await humanDelay(800, 1500);
      return;
    }
  }

  for (const ctx of contexts) {
    for (const sel of treeSelectors) {
      const link = ctx.locator(sel).first();
      if ((await link.count().catch(() => 0)) < 1) continue;
      if (!(await link.isVisible({ timeout: 2_000 }).catch(() => false))) continue;
      await link.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
      await humanDelay(300, 700);
      try {
        await link.click({ timeout: 8_000, force: true });
      } catch {
        await link.evaluate((el) => (el as HTMLElement).click());
      }
      await log("info", `Clicked Today's Follow Up tree item (${sel}).`);
      await humanDelay(800, 1500);
      return;
    }
  }

  for (const ctx of contexts) {
    const link = ctx.getByRole("link", { name: /Today'?s\s*Follow\s*Up/i }).first();
    if ((await link.count().catch(() => 0)) < 1) continue;
    await link.click({ timeout: 9_000, force: true });
    await log("info", "Clicked Today's Follow Up tree link (role fallback).");
    return;
  }

  throw new Error("Today's Follow Up tree item not found in menu");
}

export async function isOnTodaysFollowUpList(page: Page): Promise<boolean> {
  const contexts: GdmsUiRoot[] = [page];
  const ui = await resolveGdmsUiRoot(page);
  contexts.push(ui);
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }
  for (const ctx of contexts) {
    const btnSearch = ctx.locator("#btnSearch, button.btn_search.k-button").first();
    if (await btnSearch.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function clickLogoutLocator(page: Page, locator: Locator): Promise<boolean> {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await locator.waitFor({ state: "visible", timeout: 8_000 });
    await locator.click({ timeout: 12_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function tryEnvLogoutSelector(page: Page, logoutSel: string): Promise<boolean> {
  const pw = parsePwLocator(logoutSel);
  try {
    if (pw?.kind === "button") {
      await clickPwButton(page, pw.name);
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      return true;
    }
    return await clickLogoutLocator(page, page.locator(logoutSel).first());
  } catch {
    return false;
  }
}

/** HMIL GDMS 2.0: bottom-left sidebar power/logout — tried when GDMS_SEL_LOGOUT is unset or override fails. */
async function tryAutoGdmsLogout(page: Page): Promise<boolean> {
  const ui = await resolveGdmsUiRoot(page);
  const sidebar = gdmsSidebar(ui);
  const sidebarButtons = sidebar.locator('button, a, [role="button"]');

  // 1) Bottom-left power icon: last sidebar control (GDMS 2.0)
  if (await clickLogoutLocator(page, sidebarButtons.last())) {
    return true;
  }

  // 1b) Last icon-like control in sidebar (svg/img power glyph)
  if (
    await clickLogoutLocator(
      page,
      sidebar
        .locator('button:has(svg), a:has(svg), [role="button"]:has(svg), button:has(img), a:has(img)')
        .last(),
    )
  ) {
    return true;
  }

  // 2) Named logout / sign out control
  if (
    await clickLogoutLocator(
      page,
      page.getByRole("button", { name: /logout|sign out|log out/i }).first(),
    )
  ) {
    return true;
  }

  // 3) title / aria-label hints
  if (
    await clickLogoutLocator(
      page,
      page.locator('[title*="logout" i], [aria-label*="logout" i]').first(),
    )
  ) {
    return true;
  }

  // 4) Bottom-left sidebar: last clickable icon (power glyph)
  if (
    await clickLogoutLocator(
      page,
      sidebar
        .locator(
          'button, a, [role="button"], [class*="icon"], svg, i, img[alt*="power" i]',
        )
        .last(),
    )
  ) {
    return true;
  }

  return false;
}

export async function performGdmsLogout(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const logoutSel =
    process.env[GDMS_SELECTOR_ENV.logout] ?? process.env.GDMS_SEL_LOGOUT ?? "";

  const envClicked = logoutSel ? await tryEnvLogoutSelector(page, logoutSel) : false;
  if (!envClicked) {
    await tryAutoGdmsLogout(page);
  }

  await redirectToGdmsLogin(page, context, baseUrl);
}

export type WatchEndReason = "stopped" | "done";

type PublishFn = (type: string, payload: unknown) => Promise<void>;

export async function watchGdmsSession(opts: {
  page: Page;
  context: BrowserContext;
  runId: string;
  baseUrl: string;
  redis: Redis;
  log: (level: LogLinePayload["level"], message: string) => Promise<void>;
  publish: PublishFn;
  shouldStop: () => Promise<boolean>;
}): Promise<WatchEndReason> {
  const { page, context, runId, baseUrl, redis, log, publish, shouldStop } = opts;
  let lastRedirectAt = 0;

  const maybeHandleExpired = async (reason: "timeout" | "logout"): Promise<void> => {
    const now = Date.now();
    if (now - lastRedirectAt < 4_000) return;
    lastRedirectAt = now;

    if (reason === "logout") {
      await performGdmsLogout(page, context, baseUrl);
      await log("info", "GDMS logout — login page opened in preview.");
    } else {
      await redirectToGdmsLogin(page, context, baseUrl);
      await log("info", "GDMS session expired — opened login page in preview.");
    }

    await publish(SocketEvents.GDMS_SESSION_REDIRECTED, {
      workflowRunId: runId,
      reason,
    });
  };

  page.on("framenavigated", () => {
    void (async () => {
      if (await shouldStop()) return;
      if (await isGdmsSessionExpired(page)) {
        await maybeHandleExpired("timeout");
      }
    })();
  });

  await log("info", "Live preview active — Stop to end. Session timeout redirects to login automatically.");

  while (true) {
    await touchWatchHeartbeat(redis, runId);

    if (await shouldStop()) return "stopped";

    if (await isLogoutRequested(redis, runId)) {
      await clearLogoutRequest(redis, runId);
      await maybeHandleExpired("logout");
    } else if (await isGdmsSessionExpired(page)) {
      await maybeHandleExpired("timeout");
    }

    await pollDelay(WATCH_POLL_MS);
  }
}

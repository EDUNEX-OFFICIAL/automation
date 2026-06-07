import type { Redis } from "ioredis";
import type { Locator, Page } from "playwright";
import { createPrisma } from "@gdms/database";
import { applyInputGuardToPage, setAutomationInputBypass } from "./automation-browser-setup.js";
import { recordAutomationStatEvent } from "./automation-stat-events.js";
import {
  closeVisibleEnquiryModal,
  completeFollowUpTabForSkip,
  isAnyEnquiryModalVisible,
  openEnquiryDetailPage,
  type FollowUpSkipContext,
} from "./enquiry-transfer.js";
import {
  loadFollowUpSkipScLabels,
  readSalesConsultantFromFollowUpRow,
  resolveKnownScLabel,
} from "./follow-up-sc-label.js";
import {
  clearGdmsUiRootCache,
  clickBookingRetailFlyoutMgt,
  clickSalesCarSidebarIconForBooking,
  clickTodaysFollowUpTreeItem,
  flyoutShowsBookingRetailMgt,
  isTodaysFollowUpMenuItemVisible,
  isOnTodaysFollowUpList,
  resolveGdmsUiRoot,
  waitForGdmsDashboardReady,
  type GdmsUiRoot,
} from "./gdms-session-watch.js";
import {
  humanDelay,
  pollDelay,
  scaleMs,
} from "./human-delay.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";
import { incrementRunMetric } from "./run-metrics.js";

const prisma = createPrisma();

export type FollowUpSkipRunContext = FollowUpSkipContext & {
  page: Page;
  runId: string;
  dealerId: string;
  startedByUserId?: string;
  redis: Redis;
  ollamaModel?: string | null;
};

function listUiContexts(page: Page): GdmsUiRoot[] {
  const contexts: GdmsUiRoot[] = [page];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (!frame.isDetached()) contexts.push(frame);
    } catch {
      /* skip */
    }
  }
  return contexts;
}

export async function resolveListPageUi(page: Page): Promise<GdmsUiRoot> {
  for (const ui of listUiContexts(page)) {
    const btnSearch = ui.locator("#btnSearch, button.btn_search.k-button").first();
    if (await btnSearch.isVisible({ timeout: 1_500 }).catch(() => false)) return ui;
  }
  for (const ui of listUiContexts(page)) {
    if (
      await ui
        .getByText(/Today'?s\s*Follow\s*Up/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false)
    ) {
      return ui;
    }
  }
  return resolveGdmsUiRoot(page);
}

function rowLooksLikePlaceholder(texts: string[]): boolean {
  const joined = texts.join(" ").toLowerCase();
  if (!joined.trim()) return true;
  return /no\s+(data|record|enquiry)|not\s+found|empty/i.test(joined);
}

export async function parseFollowUpListRows(surface: GdmsUiRoot): Promise<Locator[]> {
  const bodyRows = surface.locator("table tbody tr");
  const rawBodyCount = await bodyRows.count();
  const out: Locator[] = [];

  for (let i = 0; i < rawBodyCount; i++) {
    const row = bodyRows.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();
    if (cellCount < 2) continue;
    const texts: string[] = [];
    for (let c = 0; c < cellCount; c++) {
      texts.push((await cells.nth(c).innerText().catch(() => "")).trim());
    }
    if (rowLooksLikePlaceholder(texts)) continue;
    out.push(row);
  }
  return out;
}

const FOLLOW_UP_LIST_LOADER_SEL =
  ".k-loading-mask:visible, .k-i-loading:visible, [class*='loading']:visible, [aria-busy='true']";

/** True while GDMS Follow Up list shows a spinner / loading mask. */
export async function isFollowUpListStillLoading(surface: GdmsUiRoot): Promise<boolean> {
  return surface
    .locator(FOLLOW_UP_LIST_LOADER_SEL)
    .first()
    .isVisible({ timeout: 250 })
    .catch(() => false);
}

/**
 * Wait until Search results finish loading — loader hidden + stable tbody/header.
 * Do not treat 0 rows as "empty" until this returns stillLoading=false.
 */
export async function waitForFollowUpListResultsSettle(
  surface: GdmsUiRoot,
  page: Page,
  log?: FollowUpSkipRunContext["log"],
  timeoutMs = 45_000,
): Promise<{ rowCount: number; stillLoading: boolean; headersReady: boolean }> {
  const loader = surface.locator(FOLLOW_UP_LIST_LOADER_SEL);
  const deadline = Date.now() + timeoutMs;

  let sawLoader = false;
  const detectDeadline = Date.now() + 4_000;
  while (Date.now() < detectDeadline) {
    if (await loader.first().isVisible({ timeout: 200 }).catch(() => false)) {
      sawLoader = true;
      break;
    }
    await pollDelay(250);
  }
  if (sawLoader) {
    if (log) await log("info", "Follow Up list loading — waiting for GDMS spinner to finish.");
    await loader
      .first()
      .waitFor({ state: "hidden", timeout: Math.max(8_000, deadline - Date.now()) })
      .catch(() => {});
  }

  await page.waitForLoadState("domcontentloaded", { timeout: scaleMs(4_000) }).catch(() => {});

  let lastCount = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    if (await isFollowUpListStillLoading(surface)) {
      stableTicks = 0;
      await loader
        .first()
        .waitFor({ state: "hidden", timeout: Math.min(12_000, deadline - Date.now()) })
        .catch(() => {});
      continue;
    }
    const headerCount = await surface.locator("table thead th, table thead td").count();
    const headersReady = headerCount > 0;
    const count = await surface.locator("table tbody tr").count();
    if (headersReady && count === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 3) {
        if (log) {
          await log(
            "info",
            `Follow Up list settled — ${count} tbody row(s), ${headerCount} header cell(s).`,
          );
        }
        return { rowCount: count, stillLoading: false, headersReady: true };
      }
    } else {
      lastCount = count;
      stableTicks = headersReady ? 1 : 0;
    }
    await pollDelay(450);
  }

  const stillLoading = await isFollowUpListStillLoading(surface);
  const headerCount = await surface.locator("table thead th, table thead td").count();
  const rowCount = await surface.locator("table tbody tr").count();
  if (log && stillLoading) {
    await log("warn", "Follow Up list still loading after wait — will retry Search (not treating as empty).");
  } else if (log && headerCount === 0) {
    await log("warn", "Follow Up list headers not ready after wait — will retry Search.");
  }
  return {
    rowCount,
    stillLoading: stillLoading || headerCount === 0,
    headersReady: headerCount > 0,
  };
}

async function isUsableListSearchButton(btn: Locator): Promise<boolean> {
  if (!(await btn.isVisible({ timeout: 800 }).catch(() => false))) return false;
  const text = (await btn.innerText().catch(() => "")).trim();
  return /search/i.test(text);
}

async function resolvePageListSearchButton(page: Page): Promise<Locator | null> {
  const ui = await resolveListPageUi(page);
  const allSearch = ui.locator(
    '#btnSearch, button.btn_search.k-button, button:has-text("Search")',
  );
  const n = await allSearch.count().catch(() => 0);
  if (n === 1) {
    const only = allSearch.first();
    return (await isUsableListSearchButton(only)) ? only : null;
  }

  let best: Locator | null = null;
  let bestY = -1;
  for (let i = 0; i < n; i++) {
    const candidate = allSearch.nth(i);
    if (!(await isUsableListSearchButton(candidate))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.y > bestY) {
      bestY = box.y;
      best = candidate;
    }
  }
  return best;
}

export async function clickSearchOnFollowUpList(
  page: Page,
  log: FollowUpSkipRunContext["log"],
): Promise<{ stillLoading: boolean }> {
  const ui = await resolveListPageUi(page);
  await log("info", "Clicking Search on Today's Follow Up list.");

  const prevBodyCount = await ui.locator("table tbody tr").count();
  const btn = await resolvePageListSearchButton(page);

  await setAutomationInputBypass(page, true);
  try {
    if (!btn) {
      throw new Error("Search button not found on Today's Follow Up list.");
    }
    await btn.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
    await humanDelay(300, 700);
    await btn.click({ timeout: 9_000, force: true });
    const settled = await waitForFollowUpListResultsSettle(ui, page, log);
    if (settled.rowCount === prevBodyCount && settled.rowCount === 0 && !settled.stillLoading) {
      await humanDelay(600, 1_200);
      const retry = await waitForFollowUpListResultsSettle(ui, page, log, 20_000);
      return { stillLoading: retry.stillLoading };
    }
    return { stillLoading: settled.stillLoading };
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

async function waitForTodaysFollowUpListShell(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isOnTodaysFollowUpList(page)) return;
    await pollDelay(500);
  }
  throw new Error(`Today's Follow Up list not ready (url=${page.url()})`);
}

export async function navigateToTodaysFollowUp(
  page: Page,
  log: FollowUpSkipRunContext["log"],
  runId: string,
): Promise<void> {
  clearGdmsUiRootCache(page);
  await log("info", "Opening Today's Follow Up (car → Booking/Retail Mgt → tree).");
  await setAutomationInputBypass(page, true);
  try {
    let todaysVisible = await isTodaysFollowUpMenuItemVisible(page);

    if (!(await flyoutShowsBookingRetailMgt(page)) && !todaysVisible) {
      await log("info", "Step 1/3: click sales car icon.");
      await clickSalesCarSidebarIconForBooking(page, log, { runId });
      await humanDelay(500, 1_000);
    }

    todaysVisible = await isTodaysFollowUpMenuItemVisible(page);
    if (!todaysVisible && (await flyoutShowsBookingRetailMgt(page))) {
      await log("info", "Step 2/3: click Booking/Retail Mgt in flyout (once).");
      await clickBookingRetailFlyoutMgt(page, log);
      await humanDelay(600, 1_200);
    } else if (!todaysVisible) {
      await log("info", "Step 2/3: open flyout then Booking/Retail Mgt.");
      await clickSalesCarSidebarIconForBooking(page, log, { runId });
      await humanDelay(500, 1_000);
      await clickBookingRetailFlyoutMgt(page, log);
      await humanDelay(600, 1_200);
    }

    await log("info", "Step 3/3: click Today's Follow Up in menu tree.");
    await clickTodaysFollowUpTreeItem(page, log);
    await humanDelay(800, 1800);
    await waitForTodaysFollowUpListShell(page);
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

async function waitForModalClosedOnList(
  listPage: Page,
  detailPage: Page,
  log: FollowUpSkipRunContext["log"],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (detailPage.isClosed()) return;
    if (!(await isAnyEnquiryModalVisible(detailPage)) && !(await isAnyEnquiryModalVisible(listPage))) {
      return;
    }
    await pollDelay(400);
  }
  await log("warn", "Enquiry modal still open after save — closing to continue list.");
  await closeVisibleEnquiryModal(detailPage.isClosed() ? listPage : detailPage, log);
}

async function processAllFollowUpRows(ctx: FollowUpSkipRunContext): Promise<number> {
  const { page: listPage, log } = ctx;
  let processed = 0;
  let loggedRowCount = false;
  const scLabels = await loadFollowUpSkipScLabels(prisma, ctx.dealerId);

  while (processed < 50) {
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();

    if (!(await isOnTodaysFollowUpList(listPage))) {
      await navigateToTodaysFollowUp(listPage, log, ctx.runId);
    }

    await clickSearchOnFollowUpList(listPage, log);
    const ui = await resolveListPageUi(listPage);
    const rows = await parseFollowUpListRows(ui);

    if (rows.length === 0) {
      if (processed === 0) {
        await log("info", "Today's Follow Up Search returned 0 rows — nothing to process.");
      }
      break;
    }

    if (!loggedRowCount) {
      await log("info", `Today's Follow Up — ${rows.length} row(s) on current page.`);
      loggedRowCount = true;
    }

    if (await isAnyEnquiryModalVisible(listPage)) {
      await log("warn", "Enquiry modal still open on list — closing before next row.");
      await closeVisibleEnquiryModal(listPage, log);
      await humanDelay(600, 1_200);
      continue;
    }

    const row = rows[0]!;
    const rawScLabel = await readSalesConsultantFromFollowUpRow(ui, row, scLabels);
    const scLabelForStats = resolveKnownScLabel(rawScLabel, scLabels) ?? rawScLabel ?? "";
    await log("info", `Opening follow-up ${processed + 1} (first row on list — double-click).`);

    let detailPage: Page;
    try {
      detailPage = await openEnquiryDetailPage(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log("error", msg);
      await closeVisibleEnquiryModal(listPage, log).catch(() => undefined);
      await humanDelay(800, 1_600);
      continue;
    }

    try {
      await completeFollowUpTabForSkip(detailPage, ctx);
      processed += 1;
      if (ctx.startedByUserId && scLabelForStats.trim()) {
        await incrementRunMetric(prisma, ctx.runId, "processed").catch(() => undefined);
        await recordAutomationStatEvent(prisma, {
          dealerId: ctx.dealerId,
          workflowRunId: ctx.runId,
          operation: "follow_up_skip",
          startedByUserId: ctx.startedByUserId,
          salesConsultantLabel: scLabelForStats.trim(),
        }).catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log("error", `Follow Up Skip failed on row: ${msg}`);
    } finally {
      await waitForModalClosedOnList(listPage, detailPage, log);
      if (!detailPage.isClosed() && detailPage !== listPage) {
        await detailPage.close().catch(() => undefined);
      }
      await humanDelay(800, 1_600);
    }
  }

  return processed;
}

export async function runFollowUpSkip(ctx: FollowUpSkipRunContext): Promise<void> {
  const { page: listPage, log } = ctx;
  await applyInputGuardToPage(listPage);

  if (await isOnTodaysFollowUpList(listPage)) {
    await log("info", "Already on Today's Follow Up list.");
  } else {
    await waitForGdmsDashboardReady(listPage, log, 180_000);
    await navigateToTodaysFollowUp(listPage, log, ctx.runId);
  }

  await log("info", "Follow Up Skip — process all rows on Today's Follow Up list until empty.");

  while (true) {
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();

    if (!(await isOnTodaysFollowUpList(listPage))) {
      await navigateToTodaysFollowUp(listPage, log, ctx.runId);
      if (!(await isOnTodaysFollowUpList(listPage))) {
        await ctx.signalManualIntervention(
          "Could not open Today's Follow Up list — check Workspace 2 preview, then Resume.",
        );
      }
    }

    const count = await processAllFollowUpRows(ctx);
    if (count === 0) {
      await log("info", "Follow Up Skip cycle complete — no rows left on list.");
      await clickSearchOnFollowUpList(listPage, log);
      await humanDelay(800, 1_400);
      const ui = await resolveListPageUi(listPage);
      const remaining = await parseFollowUpListRows(ui);
      if (remaining.length === 0) {
        await log("info", "Follow Up Skip finished — all enquiries processed.");
        break;
      }
      await log("info", "New rows appeared — starting another pass.");
      continue;
    }

    await log("info", `Follow Up Skip pass done — processed ${count} enquiry(s). Checking for more rows.`);
    await humanDelay(800, 1600);
  }
}

export { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE };

import type { Redis } from "ioredis";
import type { Locator, Page } from "playwright";
import { applyInputGuardToPage, setAutomationInputBypass } from "./automation-browser-setup.js";
import {
  closeVisibleEnquiryModal,
  completeFollowUpTabForSkip,
  isAnyEnquiryModalVisible,
  openEnquiryDetailPage,
  type FollowUpSkipContext,
} from "./enquiry-transfer.js";
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
} from "./human-delay.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";

export type FollowUpSkipRunContext = FollowUpSkipContext & {
  page: Page;
  runId: string;
  dealerId: string;
  redis: Redis;
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

async function resolveListPageUi(page: Page): Promise<GdmsUiRoot> {
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

async function parseFollowUpListRows(surface: GdmsUiRoot): Promise<Locator[]> {
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

async function clickSearchOnFollowUpList(
  page: Page,
  log: FollowUpSkipRunContext["log"],
): Promise<void> {
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
    await humanDelay(300, 800);
    await btn.click({ timeout: 9_000, force: true });
    await humanDelay(1200, 2800);

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const count = await ui.locator("table tbody tr").count();
      if (count !== prevBodyCount || count > 0) break;
      await pollDelay(400);
    }
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

  await clickSearchOnFollowUpList(listPage, log);
  const ui = await resolveListPageUi(listPage);
  let rows = await parseFollowUpListRows(ui);

  if (rows.length === 0) {
    await log("info", "Today's Follow Up Search returned 0 rows — nothing to process.");
    return 0;
  }

  await log("info", `Today's Follow Up — ${rows.length} row(s) on current page.`);

  for (let i = 0; i < rows.length; i++) {
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();

    if (!(await isOnTodaysFollowUpList(listPage))) {
      await navigateToTodaysFollowUp(listPage, log, ctx.runId);
      await clickSearchOnFollowUpList(listPage, log);
    }

    const freshUi = await resolveListPageUi(listPage);
    const freshRows = await parseFollowUpListRows(freshUi);
    if (i >= freshRows.length) break;
    const row = freshRows[i]!;

    await log("info", `Opening follow-up ${i + 1}/${freshRows.length} (double-click row).`);
    const detailPage = await openEnquiryDetailPage(row);
    try {
      await completeFollowUpTabForSkip(detailPage, ctx);
      processed += 1;
    } finally {
      await waitForModalClosedOnList(listPage, detailPage, log);
      if (!detailPage.isClosed() && detailPage !== listPage) {
        await detailPage.close().catch(() => undefined);
      }
      await humanDelay(600, 1400);
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

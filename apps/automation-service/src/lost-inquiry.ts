import type { Redis } from "ioredis";
import type { Locator, Page } from "playwright";
import { createPrisma } from "@gdms/database";
import {
  AUTOMATION_REMARK_SUFFIX,
  formatAutomationRemark,
  formatGdmsDateDdMmYyyy,
  parseLostRemarkFromHistory,
  rowRemarksStartsWithLost,
  upcomingSundayIst,
} from "@gdms/shared";
import { applyInputGuardToPage, setAutomationInputBypass } from "./automation-browser-setup.js";
import { recordAutomationStatEvent } from "./automation-stat-events.js";
import {
  closeVisibleEnquiryModal,
  gdmsClickEnquiryTab,
  gdmsFillCancelationRemark,
  gdmsOpenListPageDatePickerNearLabel,
  gdmsPickKendoCalendarDate,
  gdmsResolveLostDueToPairDropdowns,
  gdmsScrapeKendoDropdownByTrigger,
  gdmsScrapeKendoDropdownOptions,
  gdmsScrollModalToText,
  gdmsScrollKendoFieldIntoView,
  gdmsSelectKendoDropdown,
  gdmsSelectKendoDropdownByTriggerWithFallback,
  gdmsEnquiryModalFormRoot,
  gdmsVisibleEnquiryModal,
  isAnyEnquiryModalVisible,
  openEnquiryDetailPage,
  readSalesConsultantFromEnquiryModal,
  type EnquiryTransferContext,
} from "./enquiry-transfer.js";
import {
  clickSearchOnFollowUpList,
  navigateToTodaysFollowUp,
  parseFollowUpListRows,
  resolveListPageUi,
  waitForFollowUpListResultsSettle,
} from "./follow-up-skip.js";
import {
  loadFollowUpSkipScLabels,
  readSalesConsultantFromFollowUpRow,
  resolveKnownScLabel,
} from "./follow-up-sc-label.js";
import { isOnTodaysFollowUpList, waitForGdmsDashboardReady, type GdmsUiRoot } from "./gdms-session-watch.js";
import { humanDelay, humanHoverClick, pollDelay } from "./human-delay.js";
import {
  buildOptionCandidates,
  buildSubOptionCandidates,
  CANCELLATION_RULE_CONFIDENCE_THRESHOLD,
  lostDueParentHints,
  mergeCancellationPicks,
  resolveCancellationFromRemark,
} from "./lost-inquiry-cancellation-pick.js";
import { resolveLostInquiryCancellation } from "./lost-inquiry-ai.js";
import { clickGdmsLostEnquiryConfirmDialog, isLostEnquiryConfirmVisible } from "./lost-enquiry-confirm.js";
import { runLostInquirySurveillanceRecovery } from "./lost-inquiry-surveillance.js";
import { incrementRunMetric } from "./run-metrics.js";
import { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";

const prisma = createPrisma();

export type LostInquiryRunContext = Pick<
  EnquiryTransferContext,
  "log" | "shouldStop" | "waitIfPaused" | "signalManualIntervention"
> & {
  page: Page;
  runId: string;
  dealerId: string;
  startedByUserId: string;
  redis: Redis;
  ollamaModel?: string | null;
  scLabels?: string[];
  /** Avoid re-picking Follow-Up Due Date TO on every inner pass. */
  dueDateFilterApplied?: boolean;
};

const LAST_FU_REMARKS_HEADER_RE = /last\s*follow[- ]?up\s*rema/i;
const FOLLOW_UP_DUE_DATE_LABEL_RE = /follow[- ]?up\s*due\s*date/i;
const REASON_FAILURE_LABEL_RES = [
  /\*?\s*reason\s*failure/i,
  /\*?\s*reason\s*for\s*failure/i,
  /reason\s*of\s*failure/i,
] as const;
function pickFromOptions(options: string[], preferred: string | undefined, hintRes: RegExp[]): string {
  if (preferred && options.some((o) => o.toLowerCase() === preferred.toLowerCase())) return preferred;
  for (const re of hintRes) {
    const hint = options.find((o) => re.test(o));
    if (hint) return hint;
  }
  return options[0]!;
}

async function scrapeFirstMatchingDropdown(
  modal: Locator,
  labels: readonly RegExp[],
  log: LostInquiryRunContext["log"],
): Promise<{ options: string[]; label: RegExp | null }> {
  for (const label of labels) {
    await gdmsScrollKendoFieldIntoView(modal, label);
    const options = await gdmsScrapeKendoDropdownOptions(modal, label, log);
    if (options.length > 0) return { options, label };
  }
  return { options: [], label: null };
}

async function ensureCancelationInfoVisible(modal: Locator, log: LostInquiryRunContext["log"]): Promise<void> {
  await gdmsScrollModalToText(modal, CANCELATION_INFO_RE);
  const formRoot = await gdmsEnquiryModalFormRoot(modal);
  const header = formRoot.getByText(/Cancelation Info|Cancellation Info/i).first();
  if (await header.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await header.click({ force: true }).catch(() => undefined);
    await humanDelay(300, 600);
  }
  await gdmsScrollModalToText(modal, CANCELATION_INFO_RE);
  await log("info", "Cancelation Info section in view.");
}
const CANCELATION_INFO_RE = /cancelation\s*info/i;
const LOST_ENQUIRY_BTN_RE = /lost\s*enquiry/i;

async function ensureScLabels(ctx: LostInquiryRunContext): Promise<string[]> {
  if (ctx.scLabels) return ctx.scLabels;
  ctx.scLabels = await loadFollowUpSkipScLabels(prisma, ctx.dealerId);
  return ctx.scLabels;
}

async function resolveLastFollowUpRemarksColumnIndex(surface: GdmsUiRoot): Promise<number | null> {
  const headers = surface.locator("table thead th, table thead td");
  const n = await headers.count();
  for (let i = 0; i < n; i++) {
    const text = (await headers.nth(i).innerText().catch(() => "")).trim();
    if (LAST_FU_REMARKS_HEADER_RE.test(text)) return i;
  }
  return null;
}

async function rowHasLostRemarks(row: Locator, remarksCol: number): Promise<boolean> {
  const cells = row.locator("td");
  const cellCount = await cells.count();
  if (remarksCol >= cellCount) return false;
  const text = (await cells.nth(remarksCol).innerText().catch(() => "")).trim();
  return rowRemarksStartsWithLost(text);
}

async function setFollowUpDueDateToUpcomingSunday(
  page: Page,
  log: LostInquiryRunContext["log"],
  ctx?: LostInquiryRunContext,
): Promise<void> {
  if (ctx?.dueDateFilterApplied) {
    await log("info", "Follow-Up Due Date TO already set — skipping calendar.");
    return;
  }
  const ui = await resolveListPageUi(page);
  const target = upcomingSundayIst();
  const targetLabel = formatGdmsDateDdMmYyyy(target);
  const toField = ui
    .locator("dt, th, td, label")
    .filter({ hasText: FOLLOW_UP_DUE_DATE_LABEL_RE })
    .first()
    .locator("xpath=following::input[1] | ancestor::tr[1]//input[not(@type='hidden')]")
    .first();
  const current = (await toField.inputValue().catch(() => "")).trim();
  if (current && current.includes(String(target.day).padStart(2, "0")) && current.includes(String(target.year))) {
    await log("info", `Follow-Up Due Date TO already ${targetLabel} — skipping calendar.`);
    if (ctx) ctx.dueDateFilterApplied = true;
    return;
  }
  await log(
    "info",
    `Setting Follow-Up Due Date TO = upcoming Sunday (${target.day}/${target.month}/${target.year} IST).`,
  );
  await setAutomationInputBypass(page, true);
  try {
    await gdmsOpenListPageDatePickerNearLabel(ui, FOLLOW_UP_DUE_DATE_LABEL_RE, "to");
    await gdmsPickKendoCalendarDate(page, target, log);
    await page.keyboard.press("Escape").catch(() => undefined);
    await humanDelay(400, 800);
    const uiAfter = await resolveListPageUi(page);
    await waitForFollowUpListResultsSettle(uiAfter, page, log, 30_000);
    if (ctx) ctx.dueDateFilterApplied = true;
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

async function readLostRemarkFromListRow(row: Locator, remarksCol: number): Promise<string | null> {
  const cell = row.locator("td").nth(remarksCol);
  const text = (await cell.innerText().catch(() => "")).trim();
  if (!text || !rowRemarksStartsWithLost(text)) return null;
  return parseLostRemarkFromHistory(text) ?? (text.replace(/^lost\b[,;:\s-]*/i, "").trim() || null);
}

async function scrapeFollowUpHistoryRemark(modal: Locator): Promise<string | null> {
  const formRoot = await gdmsEnquiryModalFormRoot(modal);
  const historyHeading = formRoot.getByText(/^FOLLOW UP HISTORY/i).first();
  if (await historyHeading.isVisible({ timeout: 800 }).catch(() => false)) {
    const historyTable = historyHeading.locator("xpath=following::table[1]").first();
    if (await historyTable.isVisible({ timeout: 800 }).catch(() => false)) {
      const headerCells = historyTable.locator("thead th, thead td");
      let remarksIdx = -1;
      const hCount = await headerCells.count();
      for (let i = 0; i < hCount; i++) {
        const h = (await headerCells.nth(i).innerText().catch(() => "")).trim();
        if (/follow\s*up\s*remarks?/i.test(h)) {
          remarksIdx = i;
          break;
        }
      }
      const firstRow = historyTable.locator("tbody tr").first();
      if (await firstRow.isVisible({ timeout: 800 }).catch(() => false)) {
        if (remarksIdx >= 0) {
          return (await firstRow.locator("td").nth(remarksIdx).innerText().catch(() => "")).trim() || null;
        }
        const cells = firstRow.locator("td");
        const n = await cells.count();
        for (let i = 0; i < n; i++) {
          const cellText = (await cells.nth(i).innerText().catch(() => "")).trim();
          if (cellText && /lost\b/i.test(cellText)) return cellText;
        }
      }
    }
  }

  const table = formRoot.locator("table").filter({ hasText: /Follow Up Remarks/i }).first();
  if (await table.isVisible({ timeout: 800 }).catch(() => false)) {
    const headerCells = table.locator("thead th, thead td");
    let remarksIdx = -1;
    const hCount = await headerCells.count();
    for (let i = 0; i < hCount; i++) {
      const h = (await headerCells.nth(i).innerText().catch(() => "")).trim();
      if (/follow\s*up\s*remarks/i.test(h)) {
        remarksIdx = i;
        break;
      }
    }
    const firstRow = table.locator("tbody tr").first();
    if (await firstRow.isVisible({ timeout: 800 }).catch(() => false)) {
      if (remarksIdx >= 0) {
        return (await firstRow.locator("td").nth(remarksIdx).innerText().catch(() => "")).trim() || null;
      }
      return (await firstRow.innerText().catch(() => "")).trim() || null;
    }
  }

  const historyBlock = formRoot.locator("table").filter({ hasText: /Follow Up History/i }).first();
  if (await historyBlock.isVisible({ timeout: 800 }).catch(() => false)) {
    const row = historyBlock.locator("tbody tr").first();
    if (await row.isVisible({ timeout: 800 }).catch(() => false)) {
      const cells = row.locator("td");
      const n = await cells.count();
      for (let i = n - 1; i >= 0; i--) {
        const cellText = (await cells.nth(i).innerText().catch(() => "")).trim();
        if (cellText && /lost\b/i.test(cellText)) return cellText;
      }
      return (await row.innerText().catch(() => "")).trim() || null;
    }
  }

  const fallback = formRoot.locator("table tbody tr").first();
  if (await fallback.isVisible({ timeout: 800 }).catch(() => false)) {
    return (await fallback.innerText().catch(() => "")).trim() || null;
  }
  return null;
}

async function readFirstFollowUpHistoryRemark(
  modal: Locator,
  log: LostInquiryRunContext["log"],
): Promise<string | null> {
  try {
    await gdmsClickEnquiryTab(modal, /^Follow Up$/i, log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log("warn", `Could not switch to Follow Up tab — will try scraping visible history: ${msg}`);
  }
  await humanDelay(400, 800);
  const formRoot = await gdmsEnquiryModalFormRoot(modal);
  const historyAnchor = formRoot.getByText(/^FOLLOW UP HISTORY|^Follow Up History/i).first();
  await historyAnchor.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const remark = await scrapeFollowUpHistoryRemark(modal);
    if (remark) return remark;
    await pollDelay(500);
  }
  await log("warn", "Follow Up History table did not load in time.");
  return null;
}

async function confirmLostEnquiryPopup(page: Page, log: LostInquiryRunContext["log"]): Promise<void> {
  await humanDelay(400, 800);
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    if (await clickGdmsLostEnquiryConfirmDialog(page, log)) {
      await humanDelay(500, 900);
      if (!(await isLostEnquiryConfirmVisible(page))) return;
    }
    await pollDelay(300);
  }
  throw new Error("Lost Enquiry confirm popup not found.");
}

async function clickLostEnquiryButton(modal: Locator, ctx: LostInquiryRunContext): Promise<void> {
  const { log } = ctx;
  const page = modal.page();
  await gdmsScrollModalToText(modal, LOST_ENQUIRY_BTN_RE);
  const formRoot = await gdmsEnquiryModalFormRoot(modal);
  const btn = formRoot.getByRole("button", { name: LOST_ENQUIRY_BTN_RE }).first();
  if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await humanHoverClick(btn);
    await log("info", "Clicked Lost Enquiry button.");
  } else {
    const textBtn = formRoot.getByText(LOST_ENQUIRY_BTN_RE).first();
    await textBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanHoverClick(textBtn);
    await log("info", "Clicked Lost Enquiry (text match).");
  }

  try {
    await confirmLostEnquiryPopup(page, log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log("warn", `Confirm popup — direct click retry: ${msg}`);
    if (await clickGdmsLostEnquiryConfirmDialog(page, log)) {
      await humanDelay(500, 900);
      if (!(await isLostEnquiryConfirmVisible(page))) return;
    }
    await runLostInquirySurveillanceRecovery(ctx, page, "confirm_lost_enquiry", msg, {
      maxAttempts: 2,
    });
    if (await clickGdmsLostEnquiryConfirmDialog(page, log)) return;
    throw new Error("Lost Enquiry confirm popup not found.");
  }
}

async function fillCancelationInfoWithAi(
  ctx: LostInquiryRunContext,
  modal: Locator,
  parsedRemark: string,
): Promise<void> {
  const { log, signalManualIntervention, ollamaModel } = ctx;
  try {
    await log("info", "Lost Inquiry — switching to Basic Info tab → Cancelation Info.");
    await gdmsClickEnquiryTab(modal, /^Basic Info\.?$/i, log);
    await humanDelay(350, 700);
    await ensureCancelationInfoVisible(modal, log);

    const reasonScrape = await scrapeFirstMatchingDropdown(modal, REASON_FAILURE_LABEL_RES, log);
    const reasonLabel = reasonScrape.label;
    if (reasonScrape.options.length === 0 || !reasonLabel) {
      return await signalManualIntervention(
        "Could not scrape Reason Failure dropdown — open Basic Info → Cancelation Info in GDMS, then Retry lost inquiry.",
      );
    }

    const { parent: lostDueParentTrigger, sub: lostDueSubTrigger } =
      await gdmsResolveLostDueToPairDropdowns(modal);

    // Remark-first bootstrap so cascade unlock uses remark-aligned values (not generic defaults).
    const reasonBootstrapPick = resolveCancellationFromRemark(parsedRemark, reasonScrape.options, [], []);
    const reasonBootstrap = pickFromOptions(
      reasonScrape.options,
      reasonBootstrapPick.reasonFailure,
      [/customer mind change/i, /customer/i, /human error/i],
    );
    await gdmsSelectKendoDropdown(modal, reasonLabel, reasonBootstrap, log);
    await humanDelay(350, 650);

    let lostDueParentOptions = await gdmsScrapeKendoDropdownByTrigger(modal, lostDueParentTrigger, log);
    if (lostDueParentOptions.length === 0) {
      return await signalManualIntervention(
        "Could not scrape Lost due to (left) dropdown — open Cancelation Info in GDMS, then Retry lost inquiry.",
      );
    }

    const parentBootstrapPick = resolveCancellationFromRemark(
      parsedRemark,
      reasonScrape.options,
      lostDueParentOptions,
      [],
    );
    const parentBootstrap = pickFromOptions(
      lostDueParentOptions,
      parentBootstrapPick.lostDueTo,
      lostDueParentHints(parsedRemark),
    );
    await gdmsSelectKendoDropdownByTriggerWithFallback(
      modal,
      lostDueParentTrigger,
      buildOptionCandidates(lostDueParentOptions, parentBootstrap, lostDueParentHints(parsedRemark)),
      log,
    );
    await humanDelay(350, 650);

    let lostDueSubOptions: string[] = [];
    if (lostDueSubTrigger) {
      lostDueSubOptions = await gdmsScrapeKendoDropdownByTrigger(modal, lostDueSubTrigger, log);
      if (lostDueSubOptions.length === 0) {
        await humanDelay(400, 700);
        lostDueSubOptions = await gdmsScrapeKendoDropdownByTrigger(modal, lostDueSubTrigger, log);
      }
    }

    await log(
      "info",
      `Cancelation dropdowns scraped — Reason Failure=${reasonScrape.options.length}, parent=${lostDueParentOptions.length}, sub=${lostDueSubOptions.length}.`,
    );
    if (lostDueSubOptions.length > 0) {
      await log("info", `Sub options (bootstrap parent): ${lostDueSubOptions.join(" | ")}.`);
    }

    const rulePick = resolveCancellationFromRemark(
      parsedRemark,
      reasonScrape.options,
      lostDueParentOptions,
      lostDueSubOptions.length > 0 ? lostDueSubOptions : lostDueParentOptions,
    );
    await log(
      "info",
      `Remark rules — category=${rulePick.category}, confidence=${rulePick.confidence}% → Reason="${rulePick.reasonFailure}", parent="${rulePick.lostDueTo}"${rulePick.lostDueToSub ? `, sub="${rulePick.lostDueToSub}"` : ""}.`,
    );

    let aiPick = null;
    if (rulePick.confidence < CANCELLATION_RULE_CONFIDENCE_THRESHOLD) {
      await log(
        "info",
        `Rule confidence below ${CANCELLATION_RULE_CONFIDENCE_THRESHOLD}% — asking Ollama for Cancelation combination — remark "${parsedRemark.slice(0, 48)}".`,
      );
      aiPick = await resolveLostInquiryCancellation({
        remark: parsedRemark,
        reasonFailureOptions: reasonScrape.options,
        lostDueToOptions: lostDueParentOptions,
        lostDueToSubOptions: lostDueSubOptions.length > 0 ? lostDueSubOptions : lostDueParentOptions,
        model: ollamaModel,
      });
      if (aiPick) {
        await log(
          "info",
          `Ollama suggestion — Reason="${aiPick.reasonFailure}", parent="${aiPick.lostDueTo}", sub="${aiPick.lostDueToSub}".`,
        );
      }
    }

    const merged = mergeCancellationPicks(
      rulePick,
      aiPick,
      reasonScrape.options,
      lostDueParentOptions,
      lostDueSubOptions,
    );
    const reasonFailure = merged.reasonFailure;
    const lostDueParent = merged.lostDueTo;

    await gdmsSelectKendoDropdown(modal, reasonLabel, reasonFailure, log);
    await humanDelay(300, 550);
    await gdmsSelectKendoDropdownByTriggerWithFallback(
      modal,
      lostDueParentTrigger,
      buildOptionCandidates(lostDueParentOptions, lostDueParent, lostDueParentHints(parsedRemark)),
      log,
    );
    await log("info", `Lost due to parent selected: "${lostDueParent}".`);

    let lostDueSub = "";
    if (lostDueSubTrigger) {
      await humanDelay(350, 600);
      // Re-scrape sub after final parent — sub list depends on parent selection.
      let finalSubOptions = await gdmsScrapeKendoDropdownByTrigger(modal, lostDueSubTrigger, log);
      if (finalSubOptions.length === 0) {
        await humanDelay(400, 700);
        finalSubOptions = await gdmsScrapeKendoDropdownByTrigger(modal, lostDueSubTrigger, log);
      }
      if (finalSubOptions.length > 0) {
        const finalRulePick = resolveCancellationFromRemark(
          parsedRemark,
          reasonScrape.options,
          lostDueParentOptions,
          finalSubOptions,
        );
        const preferredSub =
          finalRulePick.subScore >= 8 ? finalRulePick.lostDueToSub : merged.lostDueToSub;
        const subCandidates = buildSubOptionCandidates(
          finalSubOptions,
          preferredSub,
          parsedRemark,
          lostDueParent,
        );
        await log(
          "info",
          `Lost due to sub candidates (first 4): ${subCandidates.slice(0, 4).join(" | ")} (from ${finalSubOptions.length} options).`,
        );
        lostDueSub = await gdmsSelectKendoDropdownByTriggerWithFallback(
          modal,
          lostDueSubTrigger,
          subCandidates,
          log,
        );
      }
    }

    await log(
      "info",
      `Cancelation picks — Reason Failure="${reasonFailure}", Lost due to="${lostDueParent}"${lostDueSub ? `, sub="${lostDueSub}"` : ""}.`,
    );
    await humanDelay(300, 600);

    const remarkText = formatAutomationRemark(parsedRemark);
    await gdmsFillCancelationRemark(modal, remarkText, log);
    await log("info", `Cancelation Remark set (${remarkText.length} chars, suffix ${AUTOMATION_REMARK_SUFFIX}).`);
  } catch (e) {
    if (e instanceof Error && e.message === ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    await log("warn", `Cancelation Info step failed: ${msg}`);
    return await signalManualIntervention(
      "Could not fill Cancelation Info — open Basic Info tab, scroll to Cancelation Info in GDMS, then Retry lost inquiry.",
    );
  }
}

async function waitForModalClosedOnList(
  listPage: Page,
  detailPage: Page,
  log: LostInquiryRunContext["log"],
): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (detailPage.isClosed()) return;
    if (!(await isAnyEnquiryModalVisible(detailPage)) && !(await isAnyEnquiryModalVisible(listPage))) {
      return;
    }
    await pollDelay(400);
  }
  await log("warn", "Enquiry modal still open after Lost Enquiry — closing to continue list.");
  await closeVisibleEnquiryModal(detailPage.isClosed() ? listPage : detailPage, log);
}

type ProcessLostRowResult = { ok: true } | { ok: false; reason: string };

async function processOneLostInquiry(
  ctx: LostInquiryRunContext,
  row: Locator,
  ui: GdmsUiRoot,
  scLabels: string[],
  remarksCol: number,
): Promise<ProcessLostRowResult> {
  const { page: listPage, log } = ctx;
  const listScLabel = await readSalesConsultantFromFollowUpRow(ui, row, scLabels);
  const listRemarkHint = await readLostRemarkFromListRow(row, remarksCol);
  await log(
    "info",
    `Opening Lost inquiry row${listScLabel ? ` (list SC: ${listScLabel})` : ""}${listRemarkHint ? ` — "${listRemarkHint.slice(0, 48)}"` : ""} — double-click.`,
  );

  let detailPage: Page | null = null;
  if (await isAnyEnquiryModalVisible(listPage)) {
    await log("info", "Enquiry modal already open — continuing on current modal.");
    detailPage = listPage;
  } else {
    const openStarted = Date.now();
    detailPage = await openEnquiryDetailPage(row, { fast: true }).catch(() => null);
    if (!detailPage) {
      detailPage = await runLostInquirySurveillanceRecovery(
        ctx,
        listPage,
        "open_enquiry_modal",
        "SALES CUSTOMER ENQUIRY INFO modal did not appear after double-clicking enquiry row",
        { row, parsedRemark: listRemarkHint, maxAttempts: 2 },
      );
    }
    if (detailPage) {
      await log("info", `Enquiry modal open took ${Date.now() - openStarted}ms.`);
    }
  }
  if (!detailPage) {
    return {
      ok: false,
      reason:
        "Could not open enquiry modal — double-click the Lost row in GDMS, then press Retry lost inquiry.",
    };
  }

  let scLabelForStats = listScLabel ?? "Unknown";
  let processed = false;

  try {
    const fromModal =
      listScLabel != null
        ? null
        : await readSalesConsultantFromEnquiryModal(detailPage).catch(() => null);
    const modalScLabel = fromModal ? resolveKnownScLabel(fromModal, scLabels) : null;
    if (modalScLabel) {
      scLabelForStats = modalScLabel;
    } else if (listScLabel) {
      scLabelForStats = listScLabel;
    }

    const modal = await gdmsVisibleEnquiryModal(detailPage, { fast: true });
    let parsedRemark = listRemarkHint;
    let historyText: string | null = null;

    if (parsedRemark) {
      await log("info", `Using list remark: "${parsedRemark.slice(0, 80)}" — skipping Follow Up History wait.`);
    } else {
      historyText = await readFirstFollowUpHistoryRemark(modal, log);
      parsedRemark = historyText ? parseLostRemarkFromHistory(historyText) : null;
    }

    if (!parsedRemark && historyText) {
      const reason = `Could not parse Lost remark from history: "${historyText.slice(0, 80)}" — fix in GDMS, then Retry lost inquiry.`;
      await log("warn", reason);
      return { ok: false, reason };
    }

    if (!parsedRemark) {
      const reason =
        "Follow Up History is empty — open the Follow Up tab, confirm row 1 remark, then Retry lost inquiry.";
      await log("warn", reason);
      return { ok: false, reason };
    }
    await log("info", `Parsed Lost remark: "${parsedRemark}".`);

    await fillCancelationInfoWithAi(ctx, modal, parsedRemark);
    await gdmsScrollModalToText(modal, LOST_ENQUIRY_BTN_RE);
    try {
      await clickLostEnquiryButton(modal, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log("warn", `Lost Enquiry step failed: ${msg}`);
      const reason = /confirm popup/i.test(msg)
        ? "Lost Enquiry clicked but Confirm popup not found — click Confirm in GDMS, then Retry lost inquiry."
        : "Could not complete Lost Enquiry — scroll to Cancelation Info, click Lost Enquiry → Confirm in GDMS, then Retry lost inquiry.";
      return { ok: false, reason };
    }
    processed = true;

    await incrementRunMetric(prisma, ctx.runId, "processed").catch(() => undefined);
    await recordAutomationStatEvent(prisma, {
      dealerId: ctx.dealerId,
      workflowRunId: ctx.runId,
      operation: "lost_inquiry",
      startedByUserId: ctx.startedByUserId,
      salesConsultantLabel: scLabelForStats,
    }).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.message === ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE) throw e;
    if (e instanceof Error && e.message === "stopped") throw e;
    const msg = e instanceof Error ? e.message : String(e);
    await log("warn", `Lost row processing failed: ${msg}`);
    return {
      ok: false,
      reason: `Lost Inquiry step failed — check GDMS modal, then Retry lost inquiry.`,
    };
  } finally {
    if (processed) {
      await waitForModalClosedOnList(listPage, detailPage, log);
    } else {
      const surface = detailPage.isClosed() ? listPage : detailPage;
      await closeVisibleEnquiryModal(surface, log).catch(() => undefined);
    }
    if (!detailPage.isClosed() && detailPage !== listPage) {
      await detailPage.close().catch(() => undefined);
    }
    await humanDelay(200, 450);
  }
}

async function countLostRowsOnPage(
  ui: GdmsUiRoot,
): Promise<{ rows: Locator[]; remarksCol: number | null; lostRows: Locator[] }> {
  const rows = await parseFollowUpListRows(ui);
  const remarksCol = await resolveLastFollowUpRemarksColumnIndex(ui);
  if (remarksCol == null) {
    return { rows, remarksCol, lostRows: [] };
  }
  const lostRows: Locator[] = [];
  for (const row of rows) {
    if (await rowHasLostRemarks(row, remarksCol)) lostRows.push(row);
  }
  return { rows, remarksCol, lostRows };
}

type LostPageScanResult = {
  processed: number;
  listStillLoading: boolean;
};

async function searchAndCountLostRows(
  listPage: Page,
  log: LostInquiryRunContext["log"],
): Promise<{
  ui: GdmsUiRoot;
  remarksCol: number | null;
  lostRows: Locator[];
  listStillLoading: boolean;
}> {
  const search = await clickSearchOnFollowUpList(listPage, log);
  if (search.stillLoading) {
    const ui = await resolveListPageUi(listPage);
    return { ui, remarksCol: null, lostRows: [], listStillLoading: true };
  }
  const ui = await resolveListPageUi(listPage);
  const settled = await waitForFollowUpListResultsSettle(ui, listPage, log);
  if (settled.stillLoading) {
    return { ui, remarksCol: null, lostRows: [], listStillLoading: true };
  }
  const { remarksCol, lostRows } = await countLostRowsOnPage(ui);
  return { ui, remarksCol, lostRows, listStillLoading: false };
}

async function processAllLostRowsOnPage(ctx: LostInquiryRunContext): Promise<LostPageScanResult> {
  const { page: listPage, log } = ctx;
  let processed = 0;

  await setFollowUpDueDateToUpcomingSunday(listPage, log, ctx);

  let scan = await searchAndCountLostRows(listPage, log);
  if (scan.listStillLoading) {
    await log("warn", "GDMS still loading after first Search — waiting, then Search again.");
    await humanDelay(2_000, 4_000);
    scan = await searchAndCountLostRows(listPage, log);
  }
  if (scan.listStillLoading) {
    await log("warn", "GDMS list not settled — will retry (not marking run complete).");
    return { processed: 0, listStillLoading: true };
  }

  let { remarksCol, lostRows } = scan;

  if (lostRows.length === 0) {
    await log("info", "First Search — no Lost rows yet; one more Search after list settle.");
    scan = await searchAndCountLostRows(listPage, log);
    if (scan.listStillLoading) {
      return { processed: 0, listStillLoading: true };
    }
    remarksCol = scan.remarksCol;
    lostRows = scan.lostRows;
  }

  const scLabels = await ensureScLabels(ctx);

  if (remarksCol == null) {
    await log(
      "warn",
      "Last follow-up Remarks column not found — list may still be loading; will retry Search.",
    );
    return { processed: 0, listStillLoading: true };
  }

  if (lostRows.length === 0) {
    await log("info", "No rows with Last follow-up Remarks starting with Lost on current page.");
    return { processed: 0, listStillLoading: false };
  }

  await log("info", `Lost Inquiry — ${lostRows.length} matching row(s) on current page.`);

  let skipped = 0;
  let lastSkipReason: string | null = null;
  for (let i = 0; i < lostRows.length; i++) {
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();

    if (!(await isOnTodaysFollowUpList(listPage))) {
      await navigateToTodaysFollowUp(listPage, log, ctx.runId);
      ctx.dueDateFilterApplied = false;
      await setFollowUpDueDateToUpcomingSunday(listPage, log, ctx);
      const retrySearch = await clickSearchOnFollowUpList(listPage, log);
      if (retrySearch.stillLoading) {
        await log("warn", "List still loading after mid-run Search — pausing before next row.");
        await humanDelay(2_000, 3_500);
      }
    }

    const freshUi = await resolveListPageUi(listPage);
    const { lostRows: freshLost } = await countLostRowsOnPage(freshUi);
    if (i >= freshLost.length) break;
    const row = freshLost[i]!;

    const result = await processOneLostInquiry(ctx, row, freshUi, scLabels, remarksCol);
    if (result.ok) processed += 1;
    else {
      skipped += 1;
      lastSkipReason = result.reason;
    }
  }

  if (lostRows.length > 0 && processed === 0 && skipped > 0) {
    await ctx.signalManualIntervention(
      lastSkipReason ??
        "Could not process Lost row(s) — check GDMS in Live session, then press Retry lost inquiry.",
    );
    return { processed, listStillLoading: false };
  }

  return { processed, listStillLoading: false };
}

export async function runLostInquiry(ctx: LostInquiryRunContext): Promise<void> {
  const { page: listPage, log } = ctx;
  await applyInputGuardToPage(listPage);

  if (await isOnTodaysFollowUpList(listPage)) {
    await log("info", "Already on Today's Follow Up list.");
  } else {
    await waitForGdmsDashboardReady(listPage, log, 180_000);
    await navigateToTodaysFollowUp(listPage, log, ctx.runId);
  }

  await log("info", "Lost Inquiry — process Lost rows until list is empty.");
  await log("info", "Ollama surveillance ON — AI will retry GDMS steps when needed.");

  let loadingRetries = 0;
  let confirmedEmptyPasses = 0;

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

    const { processed, listStillLoading } = await processAllLostRowsOnPage(ctx);

    if (listStillLoading) {
      loadingRetries += 1;
      if (loadingRetries >= 8) {
        await ctx.signalManualIntervention(
          "GDMS Today's Follow Up list keeps loading — check preview/network, then Resume lost inquiry.",
        );
      }
      await log(
        "warn",
        `List still loading (${loadingRetries}/8) — waiting for GDMS before Search again.`,
      );
      await humanDelay(3_000, 6_000);
      continue;
    }
    loadingRetries = 0;

    if (processed === 0) {
      const scan = await searchAndCountLostRows(listPage, log);
      if (scan.listStillLoading) {
        loadingRetries += 1;
        await humanDelay(2_000, 4_000);
        continue;
      }
      if (scan.lostRows.length === 0) {
        confirmedEmptyPasses += 1;
        if (confirmedEmptyPasses >= 2) {
          await log("info", "Lost Inquiry finished — list loaded, no Lost rows remain.");
          break;
        }
        await log(
          "info",
          "No Lost rows on settled list — confirming once more after Search (pass 1/2).",
        );
        await humanDelay(1_500, 3_000);
        continue;
      }
      confirmedEmptyPasses = 0;
      await log("info", `Lost rows still present (${scan.lostRows.length}) — starting another pass.`);
      continue;
    }

    confirmedEmptyPasses = 0;
    await log("info", `Lost Inquiry pass done — processed ${processed} enquiry(s). Checking for more.`);
    await humanDelay(300, 600);
  }
}

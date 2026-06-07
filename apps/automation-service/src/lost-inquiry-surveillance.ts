import type { Locator, Page } from "playwright";
import { setAutomationInputBypass } from "./automation-browser-setup.js";
import { isAnyEnquiryModalVisible, openEnquiryDetailPage } from "./enquiry-transfer.js";
import { clickGdmsLostEnquiryConfirmDialog, isLostEnquiryConfirmVisible } from "./lost-enquiry-confirm.js";
import { humanDelay, humanHoverClick, pollDelay } from "./human-delay.js";
import { requestLostInquirySurveillance } from "./lost-inquiry-ai.js";
import type { LostInquiryRunContext } from "./lost-inquiry.js";

export type SurveillanceStep =
  | "open_enquiry_modal"
  | "confirm_lost_enquiry"
  | "cancelation_info"
  | "next_follow_up_time"
  | "generic";

export type GdmsSurveillanceSnapshot = {
  url: string;
  enquiryModalOpen: boolean;
  enquiryModalTitle: boolean;
  dialogTexts: string[];
  buttonLabels: string[];
  tabLabels: string[];
  listRowCount: number;
  cancelationVisible: boolean;
  remarkVisible: boolean;
  lostEnquiryButtonVisible: boolean;
  lostEnquiryConfirmVisible: boolean;
  nextFollowUpTimeFilled: boolean;
};

export async function captureGdmsSurveillanceSnapshot(page: Page): Promise<GdmsSurveillanceSnapshot> {
  const lostEnquiryConfirmVisible = await isLostEnquiryConfirmVisible(page);
  const base = await page.evaluate(() => {
    function visibleText(el: Element): string {
      return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    }
    function isVisible(el: Element): boolean {
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
    }

    const enquiryWin = Array.from(document.querySelectorAll(".k-window, [role='dialog']")).find(
      (w) => /SALES CUSTOMER ENQUIRY INFO/i.test(w.textContent ?? "") && isVisible(w),
    );

    const dialogs = Array.from(document.querySelectorAll(".k-dialog:visible, .k-window:visible"))
      .filter(isVisible)
      .map(visibleText)
      .filter((t) => t.length > 0 && !/SALES CUSTOMER ENQUIRY INFO/i.test(t))
      .slice(0, 6);

    const buttons = Array.from(document.querySelectorAll("button, .k-button, a.k-button, input[type='button']"))
      .filter(isVisible)
      .map(visibleText)
      .filter((t) => t.length > 0 && t.length < 40)
      .slice(0, 24);

    const tabs = Array.from(document.querySelectorAll(".k-tabstrip-items .k-item, .k-tabstrip .k-link"))
      .filter(isVisible)
      .map(visibleText)
      .filter(Boolean)
      .slice(0, 12);

    const gridRows = document.querySelectorAll("table.k-selectable tbody tr, .k-grid tbody tr").length;
    const bodyText = document.body.innerText.replace(/\s+/g, " ");
    const cancelationVisible = /cancelation info|cancellation info/i.test(bodyText);
    const remarkVisible = /\bremark\b/i.test(bodyText) && cancelationVisible;
    const lostEnquiryButtonVisible = /lost enquiry/i.test(bodyText);
    const nextFollowUpTimeFilled = (() => {
      if (!enquiryWin) return false;
      const labels = Array.from(enquiryWin.querySelectorAll("dt, th, td, label")).filter((el) => {
        const n = (el.textContent ?? "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
        return /^Next Follow Up Time$/i.test(n);
      });
      for (const label of labels) {
        if (label.closest(".k-grid, [data-role='grid'], table.k-selectable")) continue;
        let valueEl: Element | null = null;
        if (label.tagName.toLowerCase() === "dt") {
          valueEl = label.nextElementSibling;
        } else {
          const row = label.closest("tr");
          if (row) {
            const cells = Array.from(row.querySelectorAll("td, th"));
            const idx = cells.indexOf(label as HTMLTableCellElement);
            if (idx >= 0 && idx + 1 < cells.length) valueEl = cells[idx + 1] ?? null;
          }
        }
        if (!valueEl) continue;
        const inputVals = Array.from(valueEl.querySelectorAll("input:not([type='hidden'])"))
          .map((inp) => (inp as HTMLInputElement).value.trim())
          .filter(Boolean);
        const blob = inputVals.join(" ").replace(/\s+/g, " ").trim();
        if (!blob || /_/.test(blob)) continue;
        if (
          /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(blob) &&
          (/\d{1,2}:\d{2}/.test(blob) || /9:?\s*30\s*PM/i.test(blob) || /\d{1,2}\s*(AM|PM)/i.test(blob))
        ) {
          return true;
        }
      }
      return false;
    })();

    return {
      url: location.href,
      enquiryModalOpen: Boolean(enquiryWin),
      enquiryModalTitle: Boolean(enquiryWin),
      dialogTexts: dialogs,
      buttonLabels: buttons,
      tabLabels: tabs,
      listRowCount: gridRows,
      cancelationVisible,
      remarkVisible,
      lostEnquiryButtonVisible,
      nextFollowUpTimeFilled,
    };
  });
  return { ...base, lostEnquiryConfirmVisible };
}

async function executeSurveillanceAction(
  page: Page,
  row: Locator | null,
  action: string,
  targetText: string | undefined,
  waitMs: number | undefined,
  log: LostInquiryRunContext["log"],
): Promise<boolean> {
  await log("info", `Ollama surveillance action: ${action}${targetText ? ` → "${targetText}"` : ""}.`);

  switch (action) {
    case "wait": {
      await pollDelay(waitMs ?? 1_500);
      return true;
    }
    case "dblclick_list_row": {
      if (!row) return false;
      await setAutomationInputBypass(page, true);
      try {
        await row.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await humanDelay(200, 450);
        await row.dblclick({ timeout: 6_000, force: true });
      } finally {
        await setAutomationInputBypass(page, false);
      }
      await humanDelay(600, 1_100);
      return isAnyEnquiryModalVisible(page);
    }
    case "click_text": {
      if (!targetText?.trim()) return false;
      const re = new RegExp(targetText.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const btn = page.getByRole("button", { name: re }).first();
      if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await humanHoverClick(btn);
        return true;
      }
      const link = page.getByText(re).first();
      if (await link.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await humanHoverClick(link);
        return true;
      }
      return false;
    }
    case "click_confirm": {
      return clickGdmsLostEnquiryConfirmDialog(page, log);
    }
    case "click_tab": {
      const tab = targetText?.trim() || "Basic Info";
      const el = page.getByText(new RegExp(`^${tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")).first();
      if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await humanHoverClick(el);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function stepResolved(step: SurveillanceStep, snapshot: GdmsSurveillanceSnapshot): boolean {
  if (step === "open_enquiry_modal") return snapshot.enquiryModalOpen;
  if (step === "confirm_lost_enquiry") return !snapshot.lostEnquiryConfirmVisible;
  if (step === "cancelation_info") return snapshot.cancelationVisible;
  if (step === "next_follow_up_time") return snapshot.nextFollowUpTimeFilled;
  return snapshot.enquiryModalOpen;
}

export async function runLostInquirySurveillanceRecovery(
  ctx: Pick<LostInquiryRunContext, "log" | "ollamaModel">,
  page: Page,
  step: SurveillanceStep,
  error: string,
  opts?: { row?: Locator | null; parsedRemark?: string | null; maxAttempts?: number },
): Promise<Page | null> {
  const { log, ollamaModel } = ctx;
  const row = opts?.row ?? null;
  const maxAttempts = opts?.maxAttempts ?? 3;
  const deadline = Date.now() + (step === "confirm_lost_enquiry" ? 15_000 : 45_000);

  await log("info", `Ollama surveillance — step "${step}" after: ${error.slice(0, 100)}.`);

  if (step === "confirm_lost_enquiry") {
    if (await clickGdmsLostEnquiryConfirmDialog(page, log)) {
      await log("info", "Ollama surveillance — Confirm clicked directly (no AI wait).");
      return page;
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) {
      await log("warn", "Ollama surveillance — time limit reached.");
      break;
    }
    const snapshot = await captureGdmsSurveillanceSnapshot(page);
    if (stepResolved(step, snapshot)) {
      await log("info", "Ollama surveillance — goal already reached.");
      return page;
    }

    const plan = await requestLostInquirySurveillance({
      step,
      error,
      remark: opts?.parsedRemark ?? null,
      snapshot,
      attempt,
      model: ollamaModel,
    });

    if (!plan || plan.action === "give_up") {
      await log("warn", `Ollama surveillance — no recovery (attempt ${attempt}).`);
      break;
    }

    await log("info", `Ollama surveillance plan: ${plan.reason.slice(0, 120)}.`);

    if (plan.action === "dblclick_list_row" && row) {
      const opened = await openEnquiryDetailPage(row, { fast: true }).catch(() => null);
      if (opened) return opened;
    }

    await executeSurveillanceAction(page, row, plan.action, plan.targetText, plan.waitMs, log);
    await pollDelay(500);

    const after = await captureGdmsSurveillanceSnapshot(page);
    if (stepResolved(step, after)) {
      await log("info", `Ollama surveillance — recovered on attempt ${attempt}.`);
      return page;
    }
  }

  return null;
}

import type { Frame, Page } from "playwright";
import { humanHoverClick, pollDelay } from "./human-delay.js";

type LogFn = (level: "info" | "warn" | "error", message: string) => Promise<void>;

async function clickConfirmViaEvaluate(root: Page | Frame): Promise<string | null> {
  return root.evaluate(() => {
    function label(btn: Element): string {
      if (btn instanceof HTMLInputElement) return (btn.value ?? "").trim();
      const inner = btn.querySelector(".k-button-text, span");
      if (inner?.textContent?.trim()) return inner.textContent.replace(/\s+/g, " ").trim();
      return (btn.textContent ?? "").replace(/\s+/g, " ").trim();
    }

    function isVisible(el: Element): boolean {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return (
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        Number(s.opacity) > 0 &&
        r.width > 0 &&
        r.height > 0
      );
    }

    function clickConfirmInContainer(container: Element): string | null {
      const candidates = container.querySelectorAll(
        'button, .k-button, a.k-button, input[type="button"], input[type="submit"]',
      );
      for (const btn of Array.from(candidates)) {
        if (!isVisible(btn)) continue;
        const t = label(btn);
        if (/^confirm$/i.test(t)) {
          (btn as HTMLElement).click();
          return t;
        }
      }
      return null;
    }

    function isLostEnquiryShell(shell: Element): boolean {
      const txt = (shell.textContent ?? "").replace(/\s+/g, " ");
      if (shell.querySelector(".k-tabstrip")) return false;
      return /lost enquiry/i.test(txt) && /do you want to proceed|confirm/i.test(txt);
    }

    for (const titleEl of Array.from(document.querySelectorAll(
      ".k-window-title, .k-dialog-title, .k-window-titlebar, .k-dialog-titlebar",
    ))) {
      if (!/lost enquiry/i.test(titleEl.textContent ?? "")) continue;
      const shell = titleEl.closest(".k-window, .k-dialog, [role='dialog']");
      if (!shell || !isVisible(shell)) continue;
      const clicked = clickConfirmInContainer(shell);
      if (clicked) return clicked;
    }

    for (const shell of Array.from(document.querySelectorAll(".k-window, .k-dialog, [role='dialog']"))) {
      if (!isVisible(shell)) continue;
      if (!isLostEnquiryShell(shell)) continue;
      const clicked = clickConfirmInContainer(shell);
      if (clicked) return clicked;
    }

    for (const btn of Array.from(document.querySelectorAll("button, .k-button, input[type='button']"))) {
      if (!isVisible(btn)) continue;
      if (!/^confirm$/i.test(label(btn))) continue;
      const shell = btn.closest(".k-window, .k-dialog, [role='dialog']");
      if (!shell || shell.querySelector(".k-tabstrip")) continue;
      if (!isLostEnquiryShell(shell)) continue;
      (btn as HTMLElement).click();
      return label(btn);
    }

    return null;
  });
}

async function clickConfirmViaLocator(page: Page): Promise<boolean> {
  const shells = page.locator(".k-window, .k-dialog, [role='dialog']").filter({
    has: page.getByText(/^Lost Enquiry$/i),
  });
  const n = await shells.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const shell = shells.nth(i);
    if (!(await shell.isVisible({ timeout: 400 }).catch(() => false))) continue;
    const confirm = shell
      .locator('button, .k-button, a.k-button, input[type="button"]')
      .filter({ hasText: /^Confirm$/i })
      .first();
    if (await confirm.isVisible({ timeout: 800 }).catch(() => false)) {
      await humanHoverClick(confirm);
      return true;
    }
    const proceed = shell.filter({ hasText: /do you want to proceed/i });
    const btn = proceed.getByRole("button", { name: /^Confirm$/i }).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await humanHoverClick(btn);
      return true;
    }
  }

  const byProceed = page.getByText(/do you want to proceed\??/i).first();
  if (await byProceed.isVisible({ timeout: 600 }).catch(() => false)) {
    const dlg = byProceed.locator("xpath=ancestor::*[contains(@class,'k-window') or contains(@class,'k-dialog')][1]");
    const btn = dlg.getByRole("button", { name: /^Confirm$/i }).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await humanHoverClick(btn);
      return true;
    }
  }
  return false;
}

/** GDMS "Lost Enquiry" → "Do you want to proceed?" → Confirm (nested on enquiry modal). */
export async function clickGdmsLostEnquiryConfirmDialog(
  page: Page,
  log?: LogFn,
): Promise<boolean> {
  const roots: (Page | Frame)[] = [page, ...page.frames()];

  for (let round = 0; round < 8; round++) {
    if (await clickConfirmViaLocator(page)) {
      if (log) await log("info", "Lost Enquiry confirm — clicked via locator.");
      return true;
    }

    for (const root of roots) {
      const dom = await clickConfirmViaEvaluate(root).catch(() => null);
      if (dom) {
        if (log) await log("info", `Lost Enquiry confirm — clicked via DOM ("${dom}").`);
        return true;
      }
    }

    await pollDelay(350);
  }
  return false;
}

export async function isLostEnquiryConfirmVisible(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      for (const el of Array.from(document.querySelectorAll(".k-window, .k-dialog, [role='dialog']"))) {
        if (el.querySelector(".k-tabstrip")) continue;
        const t = (el.textContent ?? "").replace(/\s+/g, " ");
        if (/lost enquiry/i.test(t) && /do you want to proceed/i.test(t)) return true;
      }
      return false;
    })
    .catch(() => false);
}

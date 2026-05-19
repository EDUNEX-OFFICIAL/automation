import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

const GUARD_ID = "gdms-bot-input-guard";

function resolveSidebarInpageScript(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(dir, "gdms-sidebar-inpage.js"),
    join(dir, "..", "src", "gdms-sidebar-inpage.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("gdms-sidebar-inpage.js not found");
}

export function isInputGuardEnabled(): boolean {
  const v = process.env.GDMS_BLOCK_USER_INPUT?.trim().toLowerCase();
  return v !== "false" && v !== "0";
}

/** tsx `keepNames` + Playwright evaluate — define __name in every document before other scripts. */
/** Log background XHR/fetch failures without failing the workflow. */
export function attachNonFatalNetworkLogging(
  context: BrowserContext,
  onWarn?: (message: string) => void,
): void {
  const warn = onWarn ?? ((message: string) => console.warn(message));
  context.on("requestfailed", (req) => {
    const url = req.url();
    const failure = req.failure()?.errorText ?? "failed";
    const type = req.resourceType();
    if (type === "xhr" || type === "fetch" || /\.dms|hmil\.net/i.test(url)) {
      warn(`Non-fatal request failure: ${type} ${url} (${failure})`);
    }
  });
}

export async function installAutomationBrowserScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(resolveSidebarInpageScript());

  const blockInput = isInputGuardEnabled();
  await context.addInitScript(({ guardEnabled }) => {
    const g = globalThis as typeof globalThis & { __name?: (target: unknown) => unknown };
    g.__name = (target: unknown) => target;

    if (!guardEnabled) return;

    const installGuard = (): void => {
      const doc = document;
      if (!doc.body || doc.getElementById(GUARD_ID)) return;

      const guard = doc.createElement("div");
      guard.id = GUARD_ID;
      guard.setAttribute("data-gdms-bot", "input-guard");
      guard.setAttribute("aria-hidden", "true");
      Object.assign(guard.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        background: "transparent",
        cursor: "default",
        /** Must not block Playwright clicks — keyboard-only deterrence for operators */
        pointerEvents: "none",
        userSelect: "none",
      });

      const blockKeys = (e: Event): void => {
        const w = window as Window & { __gdmsBotAutomating?: boolean };
        if (w.__gdmsBotAutomating) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      for (const type of ["keydown", "keyup", "keypress"]) {
        doc.addEventListener(type, blockKeys, true);
      }

      doc.body.appendChild(guard);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installGuard, { once: true });
    } else {
      installGuard();
    }

    const obs = new MutationObserver(() => {
      if (!document.getElementById(GUARD_ID) && document.body) installGuard();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }, { guardEnabled: blockInput });
}

/** Let Playwright click through — hide overlay briefly during automation actions. */
export async function setAutomationInputBypass(page: Page, enabled: boolean): Promise<void> {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(({ on, guardId }) => {
        const w = window as Window & { __gdmsBotAutomating?: boolean };
        w.__gdmsBotAutomating = on;
        const guard = document.getElementById(guardId);
        if (guard) guard.style.display = on ? "none" : "";
      }, { on: enabled, guardId: GUARD_ID });
    } catch {
      /* detached frame */
    }
  }
}

export async function applyInputGuardToPage(page: Page): Promise<void> {
  if (!isInputGuardEnabled()) return;

  for (const frame of page.frames()) {
    try {
      await frame.evaluate((guardId) => {
        const doc = document;
        if (!doc.body || doc.getElementById(guardId)) return;

        const guard = doc.createElement("div");
        guard.id = guardId;
        guard.setAttribute("data-gdms-bot", "input-guard");
        Object.assign(guard.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483646",
          background: "transparent",
          pointerEvents: "none",
          userSelect: "none",
        });

        const blockKeys = (e: Event): void => {
          const w = window as Window & { __gdmsBotAutomating?: boolean };
          if (w.__gdmsBotAutomating) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        for (const type of ["keydown", "keyup", "keypress"]) {
          doc.addEventListener(type, blockKeys, true);
        }

        doc.body.appendChild(guard);
      }, GUARD_ID);
    } catch {
      /* frame detached */
    }
  }
}

export function attachInputGuardListeners(page: Page): () => void {
  if (!isInputGuardEnabled()) return () => {};

  const reapply = (): void => {
    void applyInputGuardToPage(page);
  };

  page.on("framenavigated", reapply);
  page.on("load", reapply);
  void applyInputGuardToPage(page);

  return () => {
    page.off("framenavigated", reapply);
    page.off("load", reapply);
  };
}

export async function removeInputGuardFromPage(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((guardId) => {
        document.getElementById(guardId)?.remove();
      }, GUARD_ID);
    } catch {
      /* ignore */
    }
  }
}

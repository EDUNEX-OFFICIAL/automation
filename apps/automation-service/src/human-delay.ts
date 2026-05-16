import type { Locator, Page } from "playwright";
import { setAutomationInputBypass } from "./automation-browser-setup.js";
import { env } from "./config.js";

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Short jitter after hover / before micro-interactions. */
export async function microDelay(): Promise<void> {
  const ms = randomBetween(env.GDMS_MICRO_DELAY_MIN_MS, env.GDMS_MICRO_DELAY_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

/** Human-like pause between UI actions. */
export async function humanDelay(
  minMs = env.GDMS_ACTION_DELAY_MIN_MS,
  maxMs = env.GDMS_ACTION_DELAY_MAX_MS,
): Promise<void> {
  const ms = randomBetween(minMs, maxMs);
  await new Promise((r) => setTimeout(r, ms));
}

function pageFromLocator(loc: Locator): Page {
  return loc.page();
}

/** Hover briefly, pause, then click (anti-bot-ish pacing). */
export async function humanHoverClick(loc: Locator): Promise<void> {
  const page = pageFromLocator(loc);
  await setAutomationInputBypass(page, true);
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 12_000 }).catch(() => {});
    await loc.hover({ timeout: 15_000 }).catch(() => {});
    await microDelay();
    await loc.click({ timeout: 30_000, force: true });
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Sales/car sidebar (li.nav_sal): wait, stabilize, hover, then click with GDMS lag tolerance. */
export async function humanCarIconClick(loc: Locator): Promise<void> {
  const page = pageFromLocator(loc);
  await setAutomationInputBypass(page, true);
  try {
    await loc.waitFor({ state: "visible", timeout: 90_000 });
    await loc.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
    if (await loc.isDisabled().catch(() => false)) {
      throw new Error("Sales sidebar icon (nav_sal) is disabled");
    }
    await humanDelay(300, 800);
    await loc.hover({ timeout: 25_000 });
    await humanDelay(400, 1200);
    await loc.click({ timeout: 30_000, force: true });
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Pause between repeated Search clicks on the enquiry list. */
export async function searchIntervalDelay(): Promise<void> {
  const ms = randomBetween(env.GDMS_SEARCH_INTERVAL_MIN_MS, env.GDMS_SEARCH_INTERVAL_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

export function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

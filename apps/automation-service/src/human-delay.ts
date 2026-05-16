import type { Locator, Page } from "playwright";
import { setAutomationInputBypass } from "./automation-browser-setup.js";
import { env } from "./config.js";

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Scale any fixed delay by GDMS_SPEED_MULTIPLIER. */
export function scaleMs(ms: number): number {
  return Math.max(40, Math.round(ms * env.GDMS_SPEED_MULTIPLIER));
}

export function scaledRandomBetween(min: number, max: number): number {
  const lo = scaleMs(min);
  const hi = Math.max(lo, scaleMs(max));
  return randomBetween(lo, hi);
}

/** Uniform pacing tiers — avoids some steps at 2s and others at 120ms. */
const PAUSE_TIER_MS = {
  short: [200, 350],
  normal: [500, 750],
  long: [900, 1200],
} as const;

export type PauseTier = keyof typeof PAUSE_TIER_MS;

export async function pause(tier: PauseTier = "normal"): Promise<void> {
  const [min, max] = PAUSE_TIER_MS[tier];
  const ms = scaledRandomBetween(min, max);
  await new Promise((r) => setTimeout(r, ms));
}

/** Short jitter after hover / before micro-interactions. */
export async function microDelay(): Promise<void> {
  const ms = scaledRandomBetween(env.GDMS_MICRO_DELAY_MIN_MS, env.GDMS_MICRO_DELAY_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

/** @deprecated Prefer pause("normal") for consistent pacing. */
export async function humanDelay(
  minMs = env.GDMS_ACTION_DELAY_MIN_MS,
  maxMs = env.GDMS_ACTION_DELAY_MAX_MS,
): Promise<void> {
  const ms = scaledRandomBetween(minMs, maxMs);
  await new Promise((r) => setTimeout(r, ms));
}

/** Scaled poll / wait loop tick. */
export async function pollDelay(baseMs = 280): Promise<void> {
  await new Promise((r) => setTimeout(r, scaleMs(baseMs)));
}

function pageFromLocator(loc: Locator): Page {
  return loc.page();
}

/** Hover briefly, pause, then click (anti-bot-ish pacing). */
export async function humanHoverClick(loc: Locator): Promise<void> {
  const page = pageFromLocator(loc);
  await setAutomationInputBypass(page, true);
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: scaleMs(12_000) }).catch(() => {});
    await loc.hover({ timeout: scaleMs(15_000) }).catch(() => {});
    await microDelay();
    await loc.click({ timeout: scaleMs(30_000), force: true });
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Sales/car sidebar (li.nav_sal): wait, stabilize, hover, then click with GDMS lag tolerance. */
export async function humanCarIconClick(loc: Locator): Promise<void> {
  const page = pageFromLocator(loc);
  await setAutomationInputBypass(page, true);
  try {
    await loc.waitFor({ state: "visible", timeout: scaleMs(90_000) });
    await loc.scrollIntoViewIfNeeded({ timeout: scaleMs(15_000) }).catch(() => {});
    if (await loc.isDisabled().catch(() => false)) {
      throw new Error("Sales sidebar icon (nav_sal) is disabled");
    }
    await pause("short");
    await loc.hover({ timeout: scaleMs(25_000) });
    await pause("normal");
    await loc.click({ timeout: scaleMs(30_000), force: true });
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Pause between repeated Search clicks on the enquiry list. */
export async function searchIntervalDelay(): Promise<void> {
  const ms = scaledRandomBetween(env.GDMS_SEARCH_INTERVAL_MIN_MS, env.GDMS_SEARCH_INTERVAL_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

export function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

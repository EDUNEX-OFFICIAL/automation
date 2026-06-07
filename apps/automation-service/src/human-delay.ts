import type { Locator, Page } from "playwright";
import { setAutomationInputBypass } from "./automation-browser-setup.js";
import { env } from "./config.js";

export type AutomationOperationPace = "enquiry_transfer" | "follow_up_skip" | "lost_inquiry" | "default";

let activeOperationPace: AutomationOperationPace = "default";

/** Set per-run pacing (call from runner before ET / FUS). */
export function setAutomationOperationPace(operation: string): void {
  if (operation === "enquiry_transfer") {
    activeOperationPace = "enquiry_transfer";
  } else if (operation === "follow_up_skip" || operation === "follow_up") {
    activeOperationPace = "follow_up_skip";
  } else if (operation === "lost_inquiry") {
    activeOperationPace = "lost_inquiry";
  } else {
    activeOperationPace = "default";
  }
}

export function getAutomationOperationPace(): AutomationOperationPace {
  return activeOperationPace;
}

function effectiveSpeedMultiplier(): number {
  switch (activeOperationPace) {
    case "enquiry_transfer":
      return env.GDMS_ET_SPEED_MULTIPLIER;
    case "follow_up_skip":
    case "lost_inquiry":
      return env.GDMS_FUS_SPEED_MULTIPLIER;
    default:
      return env.GDMS_SPEED_MULTIPLIER;
  }
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Scale any fixed delay by the active operation speed multiplier. */
export function scaleMs(ms: number): number {
  return Math.max(25, Math.round(ms * effectiveSpeedMultiplier()));
}

export function scaledRandomBetween(min: number, max: number): number {
  const lo = scaleMs(min);
  const hi = Math.max(lo, scaleMs(max));
  return randomBetween(lo, hi);
}

/** Uniform pacing tiers — ET uses tighter gaps; FUS/LI keep slightly more margin. */
const PAUSE_TIER_MS = {
  short: [80, 140],
  normal: [150, 280],
  long: [280, 450],
} as const;

const ET_PAUSE_TIER_MS = {
  short: [35, 70],
  normal: [70, 130],
  long: [120, 220],
} as const;

export type PauseTier = keyof typeof PAUSE_TIER_MS;

export async function pause(tier: PauseTier = "normal"): Promise<void> {
  const tiers = activeOperationPace === "enquiry_transfer" ? ET_PAUSE_TIER_MS : PAUSE_TIER_MS;
  const [min, max] = tiers[tier];
  const ms = scaledRandomBetween(min, max);
  await new Promise((r) => setTimeout(r, ms));
}

/** Short jitter after hover / before micro-interactions. */
export async function microDelay(): Promise<void> {
  const ms = scaledRandomBetween(env.GDMS_MICRO_DELAY_MIN_MS, env.GDMS_MICRO_DELAY_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

/** Scaled delay between UI steps. */
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

/** Pause between repeated Search clicks on the enquiry list (ET idle poll). */
export async function searchIntervalDelay(): Promise<void> {
  const ms = scaledRandomBetween(env.GDMS_SEARCH_INTERVAL_MIN_MS, env.GDMS_SEARCH_INTERVAL_MAX_MS);
  await new Promise((r) => setTimeout(r, ms));
}

/** Brief pause after Save click before polling for toast / modal close. */
export async function saveClickSettleDelay(): Promise<void> {
  const base =
    activeOperationPace === "enquiry_transfer"
      ? { min: 350, max: 750 }
      : { min: 500, max: 1_100 };
  const ms = scaledRandomBetween(base.min, base.max);
  await new Promise((r) => setTimeout(r, ms));
}

/** Random wait before Follow Up Save — scaled by active operation pace. */
export async function followUpSaveDelay(): Promise<number> {
  const ms = scaledRandomBetween(
    env.GDMS_FOLLOW_UP_SAVE_DELAY_MIN_MS,
    env.GDMS_FOLLOW_UP_SAVE_DELAY_MAX_MS,
  );
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

export function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

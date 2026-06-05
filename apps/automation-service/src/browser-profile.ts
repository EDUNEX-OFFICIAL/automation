import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { BrowserContext } from "playwright";
import { chromium } from "playwright";
import { gdmsBrowserHeadless, gdmsChromiumLaunchArgs } from "./browser-context.js";
import { env } from "./config.js";
import { gdmsVncViewport } from "./gdms-vnc-display.js";

const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

/** Remove Chromium singleton locks left after container restart or crashed Chrome. */
export function clearStaleChromiumProfileLocks(sessionDir: string): void {
  const dirs = [sessionDir, path.join(sessionDir, "Default")];
  for (const dir of dirs) {
    for (const name of LOCK_FILES) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* missing */
      }
    }
  }
}

/** Best-effort kill of orphaned Chrome using this profile (same container). */
export function killOrphanChromiumForProfile(sessionDir: string): void {
  const needle = sessionDir.replace(/'/g, "'\\''");
  try {
    execSync(`pkill -f '${needle}' 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

export function isChromiumProfileLockError(raw: string): boolean {
  const s = raw.toLowerCase();
  return (
    s.includes("profile appears to be in use") ||
    s.includes("process_singleton") ||
    s.includes("singletonlock") ||
    s.includes("has been closed") && s.includes("launchpersistentcontext")
  );
}

export type LaunchGdmsContextOptions = {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Xvfb display for noVNC workspace (e.g. :99 enquiry, :100 follow-up skip). */
  display?: string;
};

/** Launch persistent GDMS browser; clears stale locks and retries once on profile lock. */
export async function launchGdmsPersistentContext(
  sessionDir: string,
  opts?: LaunchGdmsContextOptions,
): Promise<BrowserContext> {
  fs.mkdirSync(sessionDir, { recursive: true });
  const headless = opts?.headless ?? gdmsBrowserHeadless();
  const remoteView = Boolean(opts?.display) || env.GDMS_REMOTE_VIEW;
  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless,
    args: gdmsChromiumLaunchArgs(remoteView),
    // Fixed viewport + browser chrome exceeds Xvfb height and clips the top in noVNC.
    viewport: remoteView ? null : (opts?.viewport ?? gdmsVncViewport()),
  };
  if (opts?.display) {
    launchOpts.env = {
      ...process.env,
      DISPLAY: opts.display,
    };
  }

  const attempt = async (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(sessionDir, launchOpts);

  try {
    return await attempt();
  } catch (e) {
    const raw = String(e);
    if (!isChromiumProfileLockError(raw)) throw e;
    killOrphanChromiumForProfile(sessionDir);
    clearStaleChromiumProfileLocks(sessionDir);
    await new Promise((r) => setTimeout(r, 400));
    return await attempt();
  }
}

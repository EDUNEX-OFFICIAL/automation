import { env } from "./config.js";

/**
 * GDMS_REMOTE_VIEW: headed Chromium on Xvfb, user watches via noVNC (new browser tab, zero install).
 * GDMS_PREVIEW_STREAM only: headless + JPEG on Live session.
 * Local PC (Option B): real headed window when PLAYWRIGHT_HEADED without remote view.
 */
export function gdmsBrowserHeadless(): boolean {
  if (env.GDMS_REMOTE_VIEW) return false;
  if (env.GDMS_PREVIEW_STREAM) return true;
  return !env.PLAYWRIGHT_HEADED;
}

export function assertEnquiryTransferBrowserMode(): void {
  if (!env.PLAYWRIGHT_HEADED && !env.GDMS_PREVIEW_STREAM && !env.GDMS_REMOTE_VIEW) {
    throw new Error(
      "Enquiry transfer needs GDMS_REMOTE_VIEW, GDMS_PREVIEW_STREAM, or PLAYWRIGHT_HEADED.",
    );
  }
}

export const gdmsChromiumLaunchArgs = (): string[] => [
  "--no-sandbox",
  "--disable-dev-shm-usage",
];

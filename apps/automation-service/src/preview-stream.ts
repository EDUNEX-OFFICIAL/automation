import type { Page } from "playwright";
import { SocketEvents, type ScreenshotFramePayload } from "@gdms/shared";
import { env } from "./config.js";

export type PreviewStream = {
  captureFrame: () => Promise<void>;
  startLoop: () => void;
  stopLoop: () => void;
};

/** JPEG frames to Live session (Docker headed preview or headless non-transfer). */
export function createPreviewStream(opts: {
  runId: string;
  dealerId: string;
  getPage: () => Page | null;
  publish: (type: string, dealerId: string, payload: unknown) => Promise<void>;
  isStopped: () => Promise<boolean>;
  operation?: string;
  shotMs?: number;
}): PreviewStream {
  let seq = 0;
  let shotLoop: ReturnType<typeof setInterval> | null = null;
  const headed = env.PLAYWRIGHT_HEADED;
  const screenshotsEnabled =
    env.GDMS_PREVIEW_STREAM === true
      ? true
      : !headed && opts.operation !== "enquiry_transfer";
  const shotMs = opts.shotMs ?? 2000;

  const captureFrame = async (): Promise<void> => {
    if (!screenshotsEnabled) return;
    try {
      const page = opts.getPage();
      if (!page || page.isClosed() || (await opts.isStopped())) return;
      const buf = await page.screenshot({ type: "jpeg", quality: 60 });
      const frame: ScreenshotFramePayload = {
        workflowRunId: opts.runId,
        imageBase64: buf.toString("base64"),
        seq: ++seq,
      };
      await opts.publish(SocketEvents.SCREENSHOT_FRAME, opts.dealerId, frame);
    } catch {
      /* ignore sporadic screenshot races */
    }
  };

  return {
    captureFrame,
    startLoop: () => {
      if (!screenshotsEnabled || shotLoop) return;
      void captureFrame();
      shotLoop = setInterval(() => {
        void captureFrame();
      }, shotMs);
    },
    stopLoop: () => {
      if (shotLoop) {
        clearInterval(shotLoop);
        shotLoop = null;
      }
    },
  };
}

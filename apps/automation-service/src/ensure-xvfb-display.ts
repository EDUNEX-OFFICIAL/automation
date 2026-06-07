import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { gdmsVncViewport } from "./gdms-vnc-display.js";

function displayNumber(display: string): string {
  return display.replace(/^:/, "");
}

function xvfbProcessRunning(display: string): boolean {
  try {
    execSync(`pgrep -f "Xvfb ${display} " >/dev/null 2>&1`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function displaySocketReady(display: string): boolean {
  try {
    fs.accessSync(`/tmp/.X11-unix/X${displayNumber(display)}`);
    return true;
  } catch {
    return false;
  }
}

export function isXvfbDisplayReady(display: string): boolean {
  return xvfbProcessRunning(display) && displaySocketReady(display);
}

function spawnXvfb(display: string): void {
  const num = displayNumber(display);
  const { width, height } = gdmsVncViewport();
  try {
    execSync(`rm -f /tmp/.X${num}-lock /tmp/.X11-unix/X${num} 2>/dev/null || true`, {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
  const child = spawn(
    "Xvfb",
    [display, "-screen", "0", `${width}x${height}x24`, "-ac", "+extension", "GLX", "+render", "-noreset"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** Ensure headed Chromium has a live Xvfb before launch (entrypoint may still be warming slots). */
export async function ensureXvfbDisplay(display: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let spawned = false;

  while (Date.now() < deadline) {
    if (isXvfbDisplayReady(display)) return;
    if (!spawned && !xvfbProcessRunning(display)) {
      spawnXvfb(display);
      spawned = true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(
    `Xvfb display ${display} not ready — noVNC workspace still starting. Retry in a few seconds.`,
  );
}

export function isMissingXServerError(raw: string): boolean {
  const s = raw.toLowerCase();
  return s.includes("missing x server") || s.includes("without having a xserver running");
}

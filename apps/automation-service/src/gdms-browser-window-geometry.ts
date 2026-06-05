import { execSync } from "node:child_process";
import { gdmsVncViewport } from "./gdms-vnc-display.js";

/** Fill the Xvfb display — without a window manager, --start-maximized leaves a small floating Chrome window. */
export async function applyGdmsBrowserWindowGeometry(display: string): Promise<void> {
  const { width, height } = gdmsVncViewport();
  const displayEnv = display.startsWith(":") ? display : `:${display}`;
  const script = `
    ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --class chromium 2>/dev/null)
    if [ -z "$ids" ]; then
      ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --classname chromium 2>/dev/null)
    fi
    if [ -z "$ids" ]; then
      ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --name "Chrome" 2>/dev/null)
    fi
    for id in $ids; do
      DISPLAY=${displayEnv} xdotool windowmove --sync 0 0 "$id" 2>/dev/null || true
      DISPLAY=${displayEnv} xdotool windowsize --sync ${width} ${height} "$id" 2>/dev/null || true
    done
  `;
  try {
    execSync(script, { stdio: "ignore", timeout: 5000, shell: "/bin/bash" });
  } catch {
    /* xdotool missing or no window yet */
  }
}

export function startGdmsBrowserWindowGeometryRefresh(
  display: string,
  intervalMs = 8000,
): () => void {
  void applyGdmsBrowserWindowGeometry(display);
  const timer = setInterval(() => {
    void applyGdmsBrowserWindowGeometry(display);
  }, intervalMs);
  return () => clearInterval(timer);
}

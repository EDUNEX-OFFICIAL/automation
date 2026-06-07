import { execSync } from "node:child_process";
import { OPERATION_LABELS, type AutomationOperation } from "@gdms/shared";

/** Taskbar / noVNC window title (replaces default "Google Chrome for Testing"). */
export function gdmsBrowserWindowTitle(operation: string): string {
  const label = OPERATION_LABELS[operation as AutomationOperation] ?? operation.replace(/_/g, " ");
  return `Google Chrome — ${label}`;
}

/** Set X11 window title on the noVNC display (best-effort; GDMS may overwrite until next refresh). */
export async function applyGdmsBrowserWindowTitle(display: string, title: string): Promise<void> {
  const displayEnv = display.startsWith(":") ? display : `:${display}`;
  const safeTitle = title.replace(/'/g, `'\\''`);
  const script = `
    ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --class chromium 2>/dev/null)
    if [ -z "$ids" ]; then
      ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --classname chromium 2>/dev/null)
    fi
    if [ -z "$ids" ]; then
      ids=$(DISPLAY=${displayEnv} xdotool search --onlyvisible --name "Chrome" 2>/dev/null)
    fi
    for id in $ids; do
      DISPLAY=${displayEnv} xdotool set_window --name '${safeTitle}' "$id" 2>/dev/null || true
    done
  `;
  try {
    execSync(script, { stdio: "ignore", timeout: 5000, shell: "/bin/bash" });
  } catch {
    /* xdotool missing or no window yet */
  }
}

/** Re-apply title while GDMS runs (page navigation resets Chromium WM title). */
export function startGdmsBrowserWindowTitleRefresh(
  display: string,
  operation: string,
  intervalMs = 8000,
): () => void {
  const title = gdmsBrowserWindowTitle(operation);
  void applyGdmsBrowserWindowTitle(display, title);
  const timer = setInterval(() => {
    void applyGdmsBrowserWindowTitle(display, title);
  }, intervalMs);
  return () => clearInterval(timer);
}

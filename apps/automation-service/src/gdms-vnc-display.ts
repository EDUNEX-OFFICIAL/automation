/** Virtual display + Chromium viewport size for noVNC (keep in sync with Xvfb in docker-entrypoint.sh). */
export function gdmsVncViewport(): { width: number; height: number } {
  const width = Number(process.env.GDMS_VNC_WIDTH ?? 1920);
  const height = Number(process.env.GDMS_VNC_HEIGHT ?? 1080);
  return {
    width: Math.min(Math.max(Number.isFinite(width) ? width : 1920, 1024), 2560),
    height: Math.min(Math.max(Number.isFinite(height) ? height : 1080, 600), 1600),
  };
}

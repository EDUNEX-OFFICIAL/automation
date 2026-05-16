import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { env } from "./config.js";

type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

function sessionProfileLooksEmpty(sessionDir: string): boolean {
  const cookiesPath = path.join(sessionDir, "Default", "Cookies");
  try {
    const stat = fs.statSync(cookiesPath);
    return stat.size < 24_000;
  } catch {
    return true;
  }
}

function parseBootstrapCookies(raw: string): PlaywrightCookie[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("GDMS_BOOTSTRAP_COOKIES must be a JSON array of cookie objects");
  }
  return parsed.map((item) => {
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.value !== "string") {
      throw new Error("Each cookie needs name and value");
    }
    const domain = typeof c.domain === "string" ? c.domain : ".hmil.net";
    const cookiePath = typeof c.path === "string" ? c.path : "/";
    const out: PlaywrightCookie = {
      name: c.name,
      value: c.value,
      domain,
      path: cookiePath,
    };
    if (c.secure !== undefined) out.secure = c.secure === true;
    if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly === true;
    if (typeof c.sameSite === "string") {
      out.sameSite = c.sameSite as PlaywrightCookie["sameSite"];
    }
    if (typeof c.expires === "number") out.expires = c.expires;
    return out;
  });
}

/** Optional one-time cookie import before first navigation (local .env only). */
export async function applyGdmsBootstrapCookies(
  context: BrowserContext,
  sessionDir: string,
): Promise<boolean> {
  const raw = env.GDMS_BOOTSTRAP_COOKIES?.trim();
  if (!raw) return false;

  if (!env.GDMS_FORCE_COOKIE_BOOTSTRAP && !sessionProfileLooksEmpty(sessionDir)) {
    return false;
  }

  const cookies = parseBootstrapCookies(raw);
  if (cookies.length === 0) return false;

  await context.addCookies(cookies);
  return true;
}

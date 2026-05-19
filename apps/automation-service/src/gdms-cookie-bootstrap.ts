import fs from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import type { BrowserContext } from "playwright";
import { gdmsBootstrapRedisKey, parseGdmsBootstrapInput } from "@gdms/shared";
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

function toPlaywrightCookies(
  cookies: ReturnType<typeof parseGdmsBootstrapInput>,
): PlaywrightCookie[] {
  return cookies.map((c) => {
    const out: PlaywrightCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain ?? ".hmil.net",
      path: c.path ?? "/",
    };
    if (c.httpOnly !== undefined) out.httpOnly = c.httpOnly;
    if (c.secure !== undefined) out.secure = c.secure;
    return out;
  });
}

/** Optional cookie import before first navigation (Redis login token or local .env). */
export async function applyGdmsBootstrapCookies(
  context: BrowserContext,
  sessionDir: string,
  dealerId: string,
): Promise<boolean> {
  const redis = new Redis(env.REDIS_URL);
  try {
    const fromRedis = await redis.get(gdmsBootstrapRedisKey(dealerId));
    if (fromRedis?.trim()) {
      try {
        const cookies = toPlaywrightCookies(parseGdmsBootstrapInput(fromRedis));
        if (cookies.length > 0) {
          await context.addCookies(cookies);
          return true;
        }
      } catch {
        /* invalid stored token — fall through */
      }
    }
  } finally {
    redis.disconnect();
  }

  const raw = env.GDMS_BOOTSTRAP_COOKIES?.trim();
  if (!raw) return false;

  if (!env.GDMS_FORCE_COOKIE_BOOTSTRAP && !sessionProfileLooksEmpty(sessionDir)) {
    return false;
  }

  try {
    const cookies = toPlaywrightCookies(parseGdmsBootstrapInput(raw));
    if (cookies.length === 0) return false;
    await context.addCookies(cookies);
    return true;
  } catch {
    return false;
  }
}

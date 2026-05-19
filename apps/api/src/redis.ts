import { Redis, type RedisOptions } from "ioredis";
import { env } from "./config.js";
import { WORKFLOW_REDIS_CHANNEL } from "@gdms/shared";

/** BullMQ + long-lived subscribers need unbounded command retries while reconnecting. */
export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    return Math.min(times * 200, 3000);
  },
};

export function attachRedisConnectionWarnings(client: Redis, label: string): void {
  let lastLogMs = 0;
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastLogMs < 10_000) return;
    lastLogMs = now;
    console.error(
      `[redis:${label}] ${err.message} — Start Redis (repo docker-compose): pnpm docker:up  (host: redis://localhost:6380)`,
    );
  });
}

export const redis = new Redis(env.REDIS_URL, redisConnectionOptions);
attachRedisConnectionWarnings(redis, "api");

export { WORKFLOW_REDIS_CHANNEL };

/** OTP kept 24h so resume/retry on the same run does not require re-entry. */
export async function setOtpForRun(
  runId: string,
  otp: string,
  dealerId?: string,
  ttlSec = 86_400,
): Promise<void> {
  await redis.set(`run:${runId}:otp`, otp, "EX", ttlSec);
  await redis.publish(`run:${runId}:otp_ready`, "1");
  if (dealerId) {
    await redis.set(`dealer:${dealerId}:last_run_id`, runId, "EX", ttlSec);
    await redis.set(`dealer:${dealerId}:otp_run_id`, runId, "EX", ttlSec);
  }
}

export function dealerGdmsAuthKey(dealerId: string): string {
  return `dealer:${dealerId}:gdms_authenticated`;
}

const GDMS_BOOTSTRAP_TTL_SEC = 7 * 86_400;

export async function setDealerGdmsBootstrapCookies(
  dealerId: string,
  cookiesJson: string,
): Promise<void> {
  await redis.set(`dealer:${dealerId}:gdms_bootstrap_cookies`, cookiesJson, "EX", GDMS_BOOTSTRAP_TTL_SEC);
}

export async function getDealerGdmsBootstrapCookies(dealerId: string): Promise<string | null> {
  return redis.get(`dealer:${dealerId}:gdms_bootstrap_cookies`);
}

export async function markDealerGdmsAuthenticated(dealerId: string, runId: string): Promise<void> {
  const ttl = 7 * 86_400;
  await redis.set(dealerGdmsAuthKey(dealerId), runId, "EX", ttl);
  await redis.set(`dealer:${dealerId}:last_run_id`, runId, "EX", ttl);
}

export async function waitForOtpKey(runId: string): Promise<string | null> {
  return redis.get(`run:${runId}:otp`);
}

export function controlKey(runId: string, kind: "pause" | "stop" | "logout"): string {
  return `run:${runId}:control:${kind}`;
}

export async function setControl(
  runId: string,
  kind: "pause" | "stop" | "logout",
  value: "1" | "0",
): Promise<void> {
  await redis.set(controlKey(runId, kind), value, "EX", 86400);
}

export async function getControl(runId: string, kind: "pause" | "stop" | "logout"): Promise<boolean> {
  const v = await redis.get(controlKey(runId, kind));
  return v === "1";
}

export function watchHeartbeatKey(runId: string): string {
  return `run:${runId}:watch:heartbeat`;
}

/** True while automation keep-alive loop is polling (live preview after COMPLETED). */
export async function isWatchdogActive(runId: string, maxAgeMs = 15_000): Promise<boolean> {
  const v = await redis.get(watchHeartbeatKey(runId));
  if (!v) return false;
  const ts = Number(v);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < maxAgeMs;
}

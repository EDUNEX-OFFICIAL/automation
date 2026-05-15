import { Redis } from "ioredis";
import { env } from "./config.js";
import { WORKFLOW_REDIS_CHANNEL } from "@gdms/shared";

export const redis = new Redis(env.REDIS_URL);

export { WORKFLOW_REDIS_CHANNEL };

export async function setOtpForRun(runId: string, otp: string, ttlSec = 900): Promise<void> {
  await redis.set(`run:${runId}:otp`, otp, "EX", ttlSec);
  await redis.publish(`run:${runId}:otp_ready`, "1");
}

export async function waitForOtpKey(runId: string): Promise<string | null> {
  return redis.get(`run:${runId}:otp`);
}

export function controlKey(runId: string, kind: "pause" | "stop"): string {
  return `run:${runId}:control:${kind}`;
}

export async function setControl(runId: string, kind: "pause" | "stop", value: "1" | "0"): Promise<void> {
  await redis.set(controlKey(runId, kind), value, "EX", 86400);
}

export async function getControl(runId: string, kind: "pause" | "stop"): Promise<boolean> {
  const v = await redis.get(controlKey(runId, kind));
  return v === "1";
}

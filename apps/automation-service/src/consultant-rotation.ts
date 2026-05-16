import type { Redis } from "ioredis";

export const SALES_CONSULTANTS = [
  "Md Nafees Hussain",
  "Priyali Singh",
  "Amit Kumar",
] as const;

const redisKey = (dealerId: string) => `gdms:dealer:${dealerId}:consultant_rotation`;

/** 0-based index persisted in Redis; cycles 0 → 1 → 2 → 0 per successful transfer. */
export async function nextSalesConsultant(redis: Redis, dealerId: string): Promise<string> {
  const key = redisKey(dealerId);
  const raw = await redis.get(key);
  const index = raw ? Number.parseInt(raw, 10) : 0;
  const safe = Number.isFinite(index) ? index % SALES_CONSULTANTS.length : 0;
  return SALES_CONSULTANTS[safe]!;
}

export async function advanceConsultantRotation(redis: Redis, dealerId: string): Promise<void> {
  const key = redisKey(dealerId);
  const raw = await redis.get(key);
  const index = raw ? Number.parseInt(raw, 10) : 0;
  const safe = Number.isFinite(index) ? index % SALES_CONSULTANTS.length : 0;
  const next = (safe + 1) % SALES_CONSULTANTS.length;
  await redis.set(key, String(next));
}

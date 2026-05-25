import type { Redis } from "ioredis";

export const SALES_CONSULTANTS = [
  "Md Nafees Hussain",
  "Rakesh Kumar Singh",
  "Priyali Singh",
  "Amit Kumar",
] as const;

const redisKey = (dealerId: string) => `gdms:dealer:${dealerId}:consultant_rotation`;

/** Atomic pick — advances rotation when consultant is allocated (not only after full transfer). */
export async function pickNextSalesConsultant(redis: Redis, dealerId: string): Promise<string> {
  const key = redisKey(dealerId);
  const seq = await redis.incr(key);
  const index = (seq - 1) % SALES_CONSULTANTS.length;
  return SALES_CONSULTANTS[index]!;
}

/** @deprecated Use pickNextSalesConsultant — kept for callers not yet migrated. */
export async function nextSalesConsultant(redis: Redis, dealerId: string): Promise<string> {
  return pickNextSalesConsultant(redis, dealerId);
}

/** No-op: rotation advances in pickNextSalesConsultant via INCR. */
export async function advanceConsultantRotation(_redis: Redis, _dealerId: string): Promise<void> {}

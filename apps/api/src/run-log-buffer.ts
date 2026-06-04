import type { LogLinePayload } from "@gdms/shared";
import { RUN_LOG_BUFFER_MAX_LINES, runLogBufferKey } from "@gdms/shared";
import { redis } from "./redis.js";

const MAX_LINES = RUN_LOG_BUFFER_MAX_LINES;
const TTL_SEC = 86_400;

export async function appendRunLogBuffer(line: LogLinePayload): Promise<void> {
  const key = runLogBufferKey(line.workflowRunId);
  await redis.lpush(key, JSON.stringify(line));
  await redis.ltrim(key, 0, MAX_LINES - 1);
  await redis.expire(key, TTL_SEC);
}

/** Oldest-first log lines for Live session poll replay. */
export async function getRunLogBuffer(runId: string): Promise<LogLinePayload[]> {
  const rows = await redis.lrange(runLogBufferKey(runId), 0, MAX_LINES - 1);
  const parsed: LogLinePayload[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row) as LogLinePayload);
    } catch {
      /* skip corrupt row */
    }
  }
  return parsed.reverse();
}

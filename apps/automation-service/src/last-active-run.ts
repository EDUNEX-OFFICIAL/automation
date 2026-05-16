import { writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./config.js";

export type LastActiveRunRecord = {
  runId: string;
  dealerId: string;
  url: string;
  savedAt: string;
};

export function lastActiveRunPath(): string {
  return path.join(env.SESSIONS_DIR, "last-active-run.json");
}

/** Persist run/dealer for Retry transfer without re-OTP (no secrets). */
export async function persistLastActiveRun(input: {
  runId: string;
  dealerId: string;
  url: string;
}): Promise<void> {
  const record: LastActiveRunRecord = {
    runId: input.runId,
    dealerId: input.dealerId,
    url: input.url,
    savedAt: new Date().toISOString(),
  };
  await writeFile(lastActiveRunPath(), JSON.stringify(record, null, 2), "utf8");
}

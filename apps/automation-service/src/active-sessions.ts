import type { BrowserContext, Page } from "playwright";
import type { Redis } from "ioredis";
import { browserProfileKeyForUser } from "@gdms/shared";
import type { ExecutePayload } from "./runner.js";

export type ActiveAutomationSession = {
  runId: string;
  dealerId: string;
  startedByUserId: string;
  /** Chromium profile key — per user + operation. */
  profileKey: string;
  page: Page;
  context: BrowserContext;
  payload: ExecutePayload;
  captureFrame: () => Promise<void>;
  stopScreenshots: () => void;
};

export function browserProfileKeyForOperation(
  dealerId: string,
  operation: string,
  startedByUserId: string,
): string {
  return browserProfileKeyForUser(dealerId, operation, startedByUserId);
}

const sessions = new Map<string, ActiveAutomationSession>();

export function registerActiveSession(session: ActiveAutomationSession): void {
  sessions.set(session.runId, session);
}

export function getActiveSession(runId: string): ActiveAutomationSession | undefined {
  return sessions.get(runId);
}

export function unregisterActiveSession(runId: string): void {
  sessions.delete(runId);
}

export function hasActiveSession(runId: string): boolean {
  return sessions.has(runId);
}

/** Closes browser for this run if still registered (Stop from Live session). */
export async function forceStopSession(runId: string): Promise<boolean> {
  const s = sessions.get(runId);
  if (!s) return false;
  try {
    s.stopScreenshots();
    await s.context.close();
  } catch {
    /* ignore close errors */
  }
  sessions.delete(runId);
  return true;
}

/** Close active browsers for the same Chromium profile (same user + operation). */
export async function closeActiveSessionsForProfile(profileKey: string): Promise<void> {
  const toClose = [...sessions.values()].filter((s) => s.profileKey === profileKey);
  for (const s of toClose) {
    try {
      s.stopScreenshots();
      await s.context.close();
    } catch {
      /* ignore */
    }
    sessions.delete(s.runId);
  }
}

/** @deprecated use closeActiveSessionsForProfile */
export async function closeActiveSessionsForDealer(
  dealerId: string,
  profileKey?: string,
): Promise<void> {
  if (profileKey) {
    await closeActiveSessionsForProfile(profileKey);
    return;
  }
  const toClose = [...sessions.values()].filter((s) => s.dealerId === dealerId);
  for (const s of toClose) {
    try {
      s.stopScreenshots();
      await s.context.close();
    } catch {
      /* ignore */
    }
    sessions.delete(s.runId);
  }
}

export type RetrySessionContext = {
  redis: Redis;
  publish: (type: string, payload: unknown) => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>;
  shouldStop: () => Promise<boolean>;
  waitIfPaused: () => Promise<void>;
};

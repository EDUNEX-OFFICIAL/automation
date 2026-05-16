import type { BrowserContext, Page } from "playwright";
import type { Redis } from "ioredis";
import type { ExecutePayload } from "./runner.js";

export type ActiveAutomationSession = {
  runId: string;
  dealerId: string;
  page: Page;
  context: BrowserContext;
  payload: ExecutePayload;
  captureFrame: () => Promise<void>;
  stopScreenshots: () => void;
};

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

export type RetrySessionContext = {
  redis: Redis;
  publish: (type: string, payload: unknown) => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>;
  shouldStop: () => Promise<boolean>;
  waitIfPaused: () => Promise<void>;
};

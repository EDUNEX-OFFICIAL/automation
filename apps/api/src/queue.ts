import { Queue } from "bullmq";
import type { WorkflowJobData } from "@gdms/shared";
import { env } from "./config.js";

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    return Math.min(times * 200, 3000);
  },
};

export type { WorkflowJobData };

export const workflowQueue = new Queue<WorkflowJobData>("workflow", {
  connection,
});

export const aiCallQueue = new Queue<{ aiCallId: string }>("ai-call", { connection });

export const gdmsSyncQueue = new Queue<{ inquiryId: string; action: string }>("gdms-sync", {
  connection,
});

import { Queue } from "bullmq";
import { env } from "./config.js";

const connection = { url: env.REDIS_URL };

export const workflowQueue = new Queue<{ runId: string; dealerId: string; kind: string }>("workflow", {
  connection,
});

export const aiCallQueue = new Queue<{ aiCallId: string }>("ai-call", { connection });

export const gdmsSyncQueue = new Queue<{ inquiryId: string; action: string }>("gdms-sync", { connection });

import { Worker } from "bullmq";
import { parseEnv, workerEnvSchema, type AutomationOperation, type WorkflowJobData } from "@gdms/shared";
import { createLogger } from "@gdms/logger";
import { createPrisma } from "@gdms/database";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import {
  defaultLoginWorkflow,
  enquiryTransferWorkflow,
  operationStubWorkflow,
  type WorkflowDefinition,
} from "@gdms/workflow-engine";
import { isEnabledAutomationOperation } from "@gdms/shared";
const env = parseEnv(workerEnvSchema, process.env);
const log = createLogger("worker");
const prisma = createPrisma();

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    return Math.min(times * 200, 3000);
  },
};

function parseEnc(stored: string): EncryptedPayload {
  return JSON.parse(stored) as EncryptedPayload;
}

async function dispatchAutomation(input: {
  runId: string;
  dealerId: string;
  operation: AutomationOperation;
  sources: string[];
  subSources?: Record<string, string[]>;
  loginWorkflow: WorkflowDefinition;
  operationWorkflow: WorkflowDefinition;
  username: string;
  password: string;
}): Promise<void> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("x-internal-secret", env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me");
  const res = await fetch(`${env.AUTOMATION_SERVICE_URL}/internal/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runId: input.runId,
      dealerId: input.dealerId,
      gdmsUsername: input.username,
      gdmsPassword: input.password,
      loginWorkflow: input.loginWorkflow,
      operationWorkflow: input.operationWorkflow,
      operation: input.operation,
      sources: input.sources,
      subSources: input.subSources,
    }),
  });
  if (!res.ok) {
    throw new Error(`Automation HTTP ${res.status}`);
  }
}

function resolveOperationWorkflow(operation: AutomationOperation): WorkflowDefinition {
  if (operation === "enquiry_transfer") return enquiryTransferWorkflow();
  const targetUrl = env.GDMS_WORKFLOW_URL ?? env.GDMS_BASE_URL ?? "https://example.com";
  return operationStubWorkflow(operation, targetUrl);
}

const workflowWorker = new Worker<WorkflowJobData>(
  "workflow",
  async (job) => {
    const { runId, dealerId, operation, sources, subSources } = job.data;

    if (!isEnabledAutomationOperation(operation)) {
      throw new Error(`Operation "${operation}" is disabled`);
    }

    const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId } });
    if (!acc) throw new Error("GDMS account not configured");

    const masterKey = env.CREDENTIALS_MASTER_KEY;
    const username = decryptSecret(parseEnc(acc.usernameCipher), masterKey).trim();
    const password = decryptSecret(parseEnc(acc.passwordCipher), masterKey).trim();

    const base = env.GDMS_BASE_URL ?? "https://example.com";
    const wfRow = await prisma.dealerWorkflow.findFirst({
      where: { dealerId, name: operation, version: "1" },
    });

    const operationWorkflow: WorkflowDefinition = wfRow?.definition
      ? (wfRow.definition as unknown as WorkflowDefinition)
      : resolveOperationWorkflow(operation);

    const loginWorkflow = defaultLoginWorkflow(base);

    await dispatchAutomation({
      runId,
      dealerId,
      operation,
      sources,
      subSources,
      loginWorkflow,
      operationWorkflow,
      username,
      password,
    });
  },
  { connection },
);

workflowWorker.on("failed", async (job, err) => {
  log.error({ jobId: job?.id, err }, "workflow job failed");
  const runId = job?.data?.runId;
  if (runId) {
    await prisma.workflowRun.updateMany({
      where: { id: runId },
      data: { status: "FAILED", endedAt: new Date(), errorMessage: String(err) },
    });
  }
});

const aiWorker = new Worker<{ aiCallId: string }>(
  "ai-call",
  async (job) => {
    const { aiCallId } = job.data;
    const call = await prisma.aiCall.findUnique({
      where: { id: aiCallId },
      include: { inquiry: true, androidDevice: true },
    });
    if (!call) return;

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("x-internal-secret", env.AI_INTERNAL_SECRET ?? "dev-ai-secret-change-me");
    await fetch(`${env.AI_SERVICE_URL}/internal/call/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        aiCallId: call.id,
        phone: call.inquiry.phone,
        dealerId: call.inquiry.dealerId,
        deviceId: call.androidDevice?.deviceId,
      }),
    }).catch((e) => log.error({ e }, "ai-call dispatch failed"));
  },
  { connection },
);

aiWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err }, "ai-call job failed");
});

log.info("Workers started");

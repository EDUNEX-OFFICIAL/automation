import { Worker } from "bullmq";
import { parseEnv, workerEnvSchema, type AutomationOperation, type WorkflowJobData } from "@gdms/shared";
import { createLogger } from "@gdms/logger";
import { createPrisma } from "@gdms/database";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import {
  defaultLoginWorkflow,
  enquiryTransferWorkflow,
  followUpSkipWorkflow,
  operationStubWorkflow,
  type WorkflowDefinition,
} from "@gdms/workflow-engine";
import { isEnabledAutomationOperation } from "@gdms/shared";
const env = parseEnv(workerEnvSchema, process.env);
const log = createLogger("worker");
const prisma = createPrisma();

const redisConnection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    return Math.min(times * 200, 3000);
  },
};

function parseEnc(stored: string): EncryptedPayload {
  return JSON.parse(stored) as EncryptedPayload;
}

class AutomationDispatchError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bodySnippet: string,
  ) {
    super(message);
    this.name = "AutomationDispatchError";
  }
}

function isTransientDispatchStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
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
  let res: Response;
  try {
    res = await fetch(`${env.AUTOMATION_SERVICE_URL}/internal/execute`, {
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutomationDispatchError(`Automation unreachable: ${msg}`, 503, "");
  }
  if (!res.ok) {
    const bodySnippet = (await res.text().catch(() => "")).slice(0, 500);
    throw new AutomationDispatchError(`Automation HTTP ${res.status}`, res.status, bodySnippet);
  }
}

function resolveOperationWorkflow(operation: AutomationOperation): WorkflowDefinition {
  if (operation === "enquiry_transfer") return enquiryTransferWorkflow();
  if (operation === "follow_up_skip") return followUpSkipWorkflow();
  const targetUrl = env.GDMS_WORKFLOW_URL ?? env.GDMS_BASE_URL ?? "https://example.com";
  return operationStubWorkflow(operation, targetUrl);
}

const workflowWorker = new Worker<WorkflowJobData>(
  "workflow",
  async (job) => {
    const { runId, dealerId, operation, sources, subSources } = job.data;
    log.info({ runId, operation, jobId: job.id }, "workflow job active");

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

    await prisma.workflowRun.updateMany({
      where: { id: runId, status: "PENDING" },
      data: { status: "RUNNING", errorMessage: null },
    });

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
    log.info({ runId, operation, jobId: job.id }, "workflow job completed");
  },
  {
    connection: redisConnection,
    blockingConnection: true,
    concurrency: 1,
  },
);

workflowWorker.on("ready", () => {
  log.info("workflow worker ready (listening on Bull queue)");
});

workflowWorker.on("error", (err) => {
  log.error({ err }, "workflow worker error");
});

workflowWorker.on("completed", (job) => {
  log.info({ jobId: job.id, runId: job.data?.runId }, "workflow job finished");
});

workflowWorker.on("failed", async (job, err) => {
  const runId = job?.data?.runId;
  const dispatchErr = err instanceof AutomationDispatchError ? err : null;
  log.error(
    {
      jobId: job?.id,
      runId,
      httpStatus: dispatchErr?.httpStatus,
      bodySnippet: dispatchErr?.bodySnippet,
      err,
    },
    "workflow job failed",
  );
  if (!runId) return;

  const run = await prisma.workflowRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run) return;

  const attempts = job?.opts?.attempts ?? 1;
  const attemptsMade = job?.attemptsMade ?? 1;
  const retriesLeft = attemptsMade < attempts;

  if (
    run.status === "PENDING" &&
    dispatchErr &&
    isTransientDispatchStatus(dispatchErr.httpStatus) &&
    retriesLeft
  ) {
    log.warn({ runId, httpStatus: dispatchErr.httpStatus }, "transient automation dispatch failure — leaving run PENDING");
    return;
  }

  await prisma.workflowRun.updateMany({
    where: { id: runId },
    data: { status: "FAILED", endedAt: new Date(), errorMessage: String(err) },
  });
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
  {
    connection: redisConnection,
    blockingConnection: true,
  },
);

aiWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err }, "ai-call job failed");
});

log.info("Workers started");

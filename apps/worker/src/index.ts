import { Worker } from "bullmq";
import { parseEnv, workerEnvSchema } from "@gdms/shared";
import { createLogger } from "@gdms/logger";
import { createPrisma } from "@gdms/database";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import {
  defaultLoginWorkflow,
  inquiryFetchWorkflow,
  type WorkflowDefinition,
} from "@gdms/workflow-engine";

const env = parseEnv(workerEnvSchema, process.env);
const log = createLogger("worker");
const prisma = createPrisma();

const connection = { url: env.REDIS_URL };

function parseEnc(stored: string): EncryptedPayload {
  return JSON.parse(stored) as EncryptedPayload;
}

async function dispatchAutomation(input: {
  runId: string;
  dealerId: string;
  kind: string;
  workflow: WorkflowDefinition;
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
      workflow: input.workflow,
      kind: input.kind,
    }),
  });
  if (!res.ok) {
    throw new Error(`Automation HTTP ${res.status}`);
  }
}

const workflowWorker = new Worker(
  "workflow",
  async (job) => {
    const { runId, dealerId, kind } = job.data as {
      runId: string;
      dealerId: string;
      kind: string;
    };

    const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId } });
    if (!acc) throw new Error("GDMS account not configured");

    const masterKey = env.CREDENTIALS_MASTER_KEY;
    const username = decryptSecret(parseEnc(acc.usernameCipher), masterKey);
    const password = decryptSecret(parseEnc(acc.passwordCipher), masterKey);

    const wfRow = await prisma.dealerWorkflow.findFirst({
      where: { dealerId, name: kind, version: "1" },
    });

    let workflow: WorkflowDefinition;
    if (wfRow?.definition) {
      workflow = wfRow.definition as unknown as WorkflowDefinition;
    } else if (kind === "gdms_login") {
      const base = env.GDMS_BASE_URL ?? "https://example.com";
      workflow = defaultLoginWorkflow(base);
    } else if (kind === "inquiry_fetch") {
      const base = env.GDMS_BASE_URL ?? "https://example.com";
      let list = env.GDMS_INQUIRY_LIST_URL;
      if (!list) {
        const looksLikeLoginPath = base.includes(".dms") || /login/i.test(base);
        if (looksLikeLoginPath) {
          throw new Error(
            "Set GDMS_INQUIRY_LIST_URL — default /inquiries suffix is invalid when GDMS_BASE_URL is the login page.",
          );
        }
        list = `${base.replace(/\/$/, "")}/inquiries`;
      }
      workflow = inquiryFetchWorkflow(list);
    } else if (kind === "inquiry_transfer" || kind === "status_update") {
      workflow = {
        version: "1",
        name: kind,
        steps: [
          {
            id: "nav",
            type: "navigate",
            label: "Open target",
            url: env.GDMS_WORKFLOW_URL ?? env.GDMS_BASE_URL ?? "https://example.com",
          },
          { id: "wait", type: "wait_selector", label: "Wait page", selector: "body" },
        ],
      };
    } else {
      throw new Error(`Unknown workflow kind ${kind}`);
    }

    await dispatchAutomation({
      runId,
      dealerId,
      kind,
      workflow,
      username,
      password,
    });
  },
  { connection },
);

workflowWorker.on("failed", async (job, err) => {
  log.error({ jobId: job?.id, err }, "workflow job failed");
  const runId = (job?.data as { runId?: string } | undefined)?.runId;
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

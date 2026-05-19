import type { WorkflowRun } from "@prisma/client";
import {
  automationRunParamsSchema,
  isEnabledAutomationOperation,
  type AutomationRunParams,
} from "@gdms/shared";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import {
  defaultLoginWorkflow,
  enquiryTransferWorkflow,
  followUpSkipWorkflow,
  type WorkflowDefinition,
} from "@gdms/workflow-engine";
import { prisma } from "../prisma.js";
import { env } from "../config.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

export async function isAutomationSessionActive(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`${automationBase()}/internal/session-active/${runId}`, {
      headers: { "x-internal-secret": automationSecret() },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { active?: boolean };
    return Boolean(data.active);
  } catch {
    return false;
  }
}

async function buildResumeBody(run: WorkflowRun, params: AutomationRunParams) {
  const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId: run.dealerId } });
  if (!acc) return { ok: false as const, reason: "GDMS account not configured for this dealer." };

  const parseEnc = (stored: string): EncryptedPayload => JSON.parse(stored) as EncryptedPayload;
  const username = decryptSecret(parseEnc(acc.usernameCipher), env.CREDENTIALS_MASTER_KEY).trim();
  const password = decryptSecret(parseEnc(acc.passwordCipher), env.CREDENTIALS_MASTER_KEY).trim();

  const base =
    env.GDMS_BASE_URL ??
    process.env.GDMS_BASE_URL ??
    "https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms";
  const wfRow = await prisma.dealerWorkflow.findFirst({
    where: { dealerId: run.dealerId, name: params.operation, version: "1" },
  });
  const defaultWorkflow =
    params.operation === "follow_up_skip" ? followUpSkipWorkflow() : enquiryTransferWorkflow();
  const operationWorkflow: WorkflowDefinition = wfRow?.definition
    ? (wfRow.definition as unknown as WorkflowDefinition)
    : defaultWorkflow;
  const loginWorkflow = defaultLoginWorkflow(base);

  return {
    ok: true as const,
    body: {
      runId: run.id,
      dealerId: run.dealerId,
      gdmsUsername: username,
      gdmsPassword: password,
      loginWorkflow,
      operationWorkflow,
      operation: params.operation,
      sources: params.sources,
      subSources: params.subSources,
    },
  };
}

/** Re-opens browser profile or continues on active session after Resume from Live session. */
export async function triggerEnquiryResumeAfterControl(
  run: WorkflowRun,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const params = automationRunParamsSchema.safeParse(run.runParams);
  if (
    !params.success ||
    (params.data.operation !== "enquiry_transfer" && params.data.operation !== "follow_up_skip")
  ) {
    return { ok: false, reason: "Resume is only supported for enquiry transfer or follow up skip runs." };
  }
  if (!isEnabledAutomationOperation(params.data.operation)) {
    return { ok: false, reason: "This automation operation is disabled." };
  }

  const operation = params.data.operation;
  const retryPath =
    operation === "follow_up_skip"
      ? "internal/retry-follow-up-skip"
      : "internal/retry-enquiry-transfer";
  const resumePath =
    operation === "follow_up_skip"
      ? "internal/resume-follow-up-skip"
      : "internal/resume-enquiry-transfer";

  const active = await isAutomationSessionActive(run.id);
  if (active) {
    const res = await fetch(`${automationBase()}/${retryPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": automationSecret(),
      },
      body: JSON.stringify({ runId: run.id }),
    });
    if (res.status === 409) {
      return { ok: false, reason: "Browser session ended before resume could start." };
    }
    if (!res.ok) return { ok: false, reason: "Automation service could not continue this run." };
    return { ok: true };
  }

  const built = await buildResumeBody(run, params.data);
  if (!built.ok) return { ok: false, reason: built.reason };

  const res = await fetch(`${automationBase()}/${resumePath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": automationSecret(),
    },
    body: JSON.stringify(built.body),
  });
  if (!res.ok) return { ok: false, reason: "Automation service could not resume this session." };
  return { ok: true };
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canStartWorkflow, canAccessDealer } from "@gdms/auth";
import { workflowQueue, type WorkflowJobData } from "../queue.js";
import { setOtpForRun, setControl, isWatchdogActive } from "../redis.js";
import {
  automationRunParamsSchema,
  isEnabledAutomationOperation,
  startAutomationSchema,
  type AutomationRunParams,
} from "@gdms/shared";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import { defaultLoginWorkflow, enquiryTransferWorkflow, type WorkflowDefinition } from "@gdms/workflow-engine";
import { env } from "../config.js";
import { reconcileStaleWorkflowRunsForDealer } from "../lib/stale-workflow-run.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

export async function registerWorkflowRunRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/workflow-runs", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canStartWorkflow(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    let body: z.infer<typeof startAutomationSchema>;
    try {
      body = startAutomationSchema.parse(req.body);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.code(400).send({ error: "Invalid automation options. Check operation, sources, and sub sources." });
      }
      throw e;
    }
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await reconcileStaleWorkflowRunsForDealer(body.dealerId);

    const inFlight = await prisma.workflowRun.findFirst({
      where: {
        dealerId: body.dealerId,
        status: { in: ["PENDING", "RUNNING", "PAUSED_OTP"] },
      },
    });
    if (inFlight) {
      return reply.code(409).send({
        error:
          "An automation is already running for this dealer. Open Live session and press Stop, or wait for it to finish.",
        runId: inFlight.id,
        status: inFlight.status,
        startedAt: inFlight.startedAt.toISOString(),
      });
    }

    const runParams: AutomationRunParams = {
      operation: body.operation,
      sources: body.sources,
      ...(body.subSources ? { subSources: body.subSources } : {}),
    };

    const run = await prisma.workflowRun.create({
      data: {
        dealerId: body.dealerId,
        status: "PENDING",
        currentStep: body.operation,
        runParams: runParams as object,
      },
    });

    const jobData: WorkflowJobData = {
      runId: run.id,
      dealerId: body.dealerId,
      operation: body.operation,
      sources: body.sources,
      subSources: body.subSources,
    };

    await workflowQueue.add("execute", jobData, { jobId: run.id });
    return run;
  });

  app.get("/v1/workflow-runs", { preHandler: authPreHandler }, async (req) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return [];
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) return [];
    await reconcileStaleWorkflowRunsForDealer(dealerId);
    return prisma.workflowRun.findMany({
      where: { dealerId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  });

  /** Latest in-flight or paused run (for Live session when admin has no dealerId on JWT). */
  app.get("/v1/workflow-runs/in-flight", { preHandler: authPreHandler }, async (req) => {
    const queryDealer = (req.query as { dealerId?: string }).dealerId;
    const userDealer = req.user!.dealerId ?? null;

    let dealerIds: string[];
    if (queryDealer) {
      if (!canAccessDealer(userDealer, queryDealer, req.user!.role)) {
        return { run: null };
      }
      dealerIds = [queryDealer];
    } else if (userDealer) {
      dealerIds = [userDealer];
    } else {
      const dealers = await prisma.dealer.findMany({ select: { id: true }, orderBy: { createdAt: "desc" } });
      dealerIds = dealers.map((d) => d.id);
    }

    const activeStatuses = ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER", "FAILED"] as const;
    const pickInFlight = (
      runs: Awaited<ReturnType<typeof prisma.workflowRun.findMany>>,
    ) =>
      runs.find((r) => r.status === "RUNNING") ??
      runs.find((r) => r.status === "PAUSED_OTP") ??
      runs.find((r) => r.status === "PAUSED_USER") ??
      runs.find((r) => r.status === "PENDING") ??
      runs.find((r) => r.status === "FAILED");

    for (const dealerId of dealerIds) {
      await reconcileStaleWorkflowRunsForDealer(dealerId);
      const runs = await prisma.workflowRun.findMany({
        where: { dealerId, status: { in: [...activeStatuses] } },
        orderBy: { startedAt: "desc" },
        take: 15,
      });
      const run = pickInFlight(runs);
      if (run) return { run };
    }
    return { run: null };
  });

  app.post(
    "/v1/workflow-runs/reconcile-stale",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const body = z.object({ dealerId: z.string() }).parse(req.body);
      if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const result = await reconcileStaleWorkflowRunsForDealer(body.dealerId);
      return result;
    },
  );

  app.get<{ Params: { id: string } }>("/v1/workflow-runs/:id", { preHandler: authPreHandler }, async (req, reply) => {
    const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
    if (!run) return reply.code(404).send({ error: "Not found" });
    if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    return run;
  });

  app.post<{ Params: { id: string } }>("/v1/workflow-runs/:id/otp", { preHandler: authPreHandler }, async (req, reply) => {
    const otp = z.object({ otp: z.string().min(4) }).parse(req.body).otp;
    const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
    if (!run) return reply.code(404).send({ error: "Not found" });
    if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    await setOtpForRun(run.id, otp, run.dealerId);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/control",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const body = z
        .object({ action: z.enum(["pause", "resume", "stop"]) })
        .parse(req.body);
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (body.action === "pause") await setControl(run.id, "pause", "1");
      if (body.action === "resume") await setControl(run.id, "pause", "0");
      if (body.action === "stop") await setControl(run.id, "stop", "1");
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/gdms-logout",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (run.status !== "RUNNING" && run.status !== "COMPLETED") {
        return reply.code(409).send({ error: "Run is not in live preview" });
      }
      if (run.status === "COMPLETED" && !(await isWatchdogActive(run.id))) {
        return reply.code(409).send({
          error:
            "Live preview is no longer active. The browser session has ended — start a new GDMS login to open the preview again.",
        });
      }
      await setControl(run.id, "logout", "1");
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/resume-session",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const params = automationRunParamsSchema.safeParse(run.runParams);
      if (!params.success || params.data.operation !== "enquiry_transfer") {
        return reply.code(409).send({
          error: "Resume is only available for enquiry transfer runs with saved options.",
        });
      }

      if (
        run.status !== "FAILED" &&
        run.status !== "PAUSED_USER" &&
        run.status !== "RUNNING" &&
        run.status !== "PAUSED_OTP" &&
        run.status !== "STOPPED"
      ) {
        return reply.code(409).send({
          error: "This run cannot be resumed. Start a new automation from the dashboard instead.",
        });
      }

      if (!isEnabledAutomationOperation(params.data.operation)) {
        return reply.code(409).send({ error: "This automation operation is disabled." });
      }

      await reconcileStaleWorkflowRunsForDealer(run.dealerId);

      const otherInFlight = await prisma.workflowRun.findFirst({
        where: {
          dealerId: run.dealerId,
          id: { not: run.id },
          status: { in: ["PENDING", "RUNNING", "PAUSED_OTP"] },
        },
      });
      if (otherInFlight) {
        return reply.code(409).send({
          error:
            "Another automation is already running for this dealer. Stop it first, then resume this session.",
          runId: otherInFlight.id,
        });
      }

      const acc = await prisma.gdmsAccount.findUnique({ where: { dealerId: run.dealerId } });
      if (!acc) {
        return reply.code(409).send({ error: "GDMS account not configured for this dealer." });
      }

      const parseEnc = (stored: string): EncryptedPayload => JSON.parse(stored) as EncryptedPayload;
      const username = decryptSecret(parseEnc(acc.usernameCipher), env.CREDENTIALS_MASTER_KEY).trim();
      const password = decryptSecret(parseEnc(acc.passwordCipher), env.CREDENTIALS_MASTER_KEY).trim();

      const base =
        env.GDMS_BASE_URL ??
        process.env.GDMS_BASE_URL ??
        "https://ndms.hmil.net/cmm/cmmd/selectHome.dms";
      const wfRow = await prisma.dealerWorkflow.findFirst({
        where: { dealerId: run.dealerId, name: params.data.operation, version: "1" },
      });
      const operationWorkflow: WorkflowDefinition = wfRow?.definition
        ? (wfRow.definition as unknown as WorkflowDefinition)
        : enquiryTransferWorkflow();
      const loginWorkflow = defaultLoginWorkflow(base);

      const res = await fetch(`${automationBase()}/internal/resume-enquiry-transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": automationSecret(),
        },
        body: JSON.stringify({
          runId: run.id,
          dealerId: run.dealerId,
          gdmsUsername: username,
          gdmsPassword: password,
          loginWorkflow,
          operationWorkflow,
          operation: params.data.operation,
          sources: params.data.sources,
          subSources: params.data.subSources,
        }),
      });
      if (!res.ok) {
        return reply.code(502).send({ error: "Automation service could not resume this session." });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/retry-transfer",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (
        run.status !== "FAILED" &&
        run.status !== "RUNNING" &&
        run.status !== "PAUSED_USER"
      ) {
        return reply.code(409).send({
          error:
            "Continue transfer is only available while the visible browser session is still open.",
        });
      }

      const res = await fetch(`${automationBase()}/internal/retry-enquiry-transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": automationSecret(),
        },
        body: JSON.stringify({ runId: run.id }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return reply.code(409).send({ error: body.error ?? "No active browser session" });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: "Automation service could not start retry" });
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/session-active",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessDealer(req.user!.dealerId, run.dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const res = await fetch(`${automationBase()}/internal/session-active/${run.id}`, {
        headers: { "x-internal-secret": automationSecret() },
      });
      if (!res.ok) return { active: false, watchdog: await isWatchdogActive(run.id) };
      const data = (await res.json()) as { active?: boolean };
      return {
        active: Boolean(data.active),
        watchdog: await isWatchdogActive(run.id),
      };
    },
  );
}

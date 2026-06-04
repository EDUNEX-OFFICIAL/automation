import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import {
  canRunAutomation,
  canAccessDealer,
  canRunEnquiryTransfer,
  canAccessWorkflowRun,
  workflowRunScopeForActor,
} from "@gdms/auth";
import { resolveEffectiveTeamType } from "../lib/team-type.js";
import { workflowQueue, type WorkflowJobData } from "../queue.js";
import { setOtpForRun, setControl, isWatchdogActive } from "../redis.js";
import {
  vncPathPrefixForUserOperation,
  vncWorkspaceForOperation,
  SocketEvents,
  automationRunParamsSchema,
  isEnabledAutomationOperation,
  startAutomationSchema,
  type AutomationRunParams,
} from "@gdms/shared";
import { publishWorkflowEvent } from "../socket.js";
import { decryptSecret, type EncryptedPayload } from "@gdms/auth";
import {
  defaultLoginWorkflow,
  enquiryTransferWorkflow,
  followUpSkipWorkflow,
  type WorkflowDefinition,
} from "@gdms/workflow-engine";
import { env } from "../config.js";
import { healWorkflowRunOnRead, reconcileStaleWorkflowRunsForDealer } from "../lib/stale-workflow-run.js";
import { getRunLogBuffer } from "../run-log-buffer.js";
import {
  ensureWorkflowJobQueued,
  isBullJobStillQueued,
  isBullJobStuckWaiting,
  purgeBullJobArtifacts,
  removeStaleBullJob,
} from "../lib/ensure-workflow-job.js";
import { triggerEnquiryResumeAfterControl } from "../lib/trigger-enquiry-resume.js";

const automationBase = () => env.AUTOMATION_SERVICE_URL ?? "http://localhost:4101";
const automationSecret = () => env.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me";

function runActor(req: { user?: { sub: string; role: string; dealerId: string | null } }) {
  return {
    sub: req.user!.sub,
    role: req.user!.role as import("@gdms/auth").Role,
    dealerId: req.user!.dealerId ?? null,
  };
}

export async function registerWorkflowRunRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/workflow-runs", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canRunAutomation(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden — automation is for Team Leaders and Sales Consultants only" });
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

    if (body.operation === "enquiry_transfer") {
      const teamType = await resolveEffectiveTeamType(req.user!.sub);
      if (!canRunEnquiryTransfer(teamType)) {
        return reply.code(403).send({
          error:
            "Enquiry transfer is only available for the Digital team. Field team can use Follow up skip from Settings.",
        });
      }
    }

    await reconcileStaleWorkflowRunsForDealer(body.dealerId);

    const inFlight = await prisma.workflowRun.findFirst({
      where: {
        ...workflowRunScopeForActor(runActor(req), { dealerId: body.dealerId }),
        status: { in: ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"] },
        runParams: { path: ["operation"], equals: body.operation },
      },
    });
    if (inFlight) {
      if (
        inFlight.status === "PENDING" &&
        (!(await isBullJobStillQueued(inFlight.id)) || (await isBullJobStuckWaiting(inFlight.id)))
      ) {
        const requeue = await ensureWorkflowJobQueued(inFlight, { force: true });
        if (requeue.ok) {
          req.log.info({ runId: inFlight.id, jobState: requeue.jobState }, "workflow job requeued for orphan PENDING");
          return inFlight;
        }
      }
      return reply.code(409).send({
        error:
          "You already have an automation running for this operation. Open Live session and press Stop, or wait for it to finish.",
        runId: inFlight.id,
        status: inFlight.status,
        startedAt: inFlight.startedAt.toISOString(),
      });
    }

    const runParams: AutomationRunParams = {
      operation: body.operation,
      sources: body.operation === "follow_up_skip" ? [] : body.sources,
      ...(body.subSources ? { subSources: body.subSources } : {}),
    };

    const run = await prisma.workflowRun.create({
      data: {
        dealerId: body.dealerId,
        startedByUserId: req.user!.sub,
        status: "PENDING",
        currentStep: body.operation,
        runParams: runParams as object,
      },
    });

    const credsUserId = req.user!.sub;
    const { getGdmsCredentialsForUser } = await import("../lib/gdms-credentials.js");
    if (!(await getGdmsCredentialsForUser(credsUserId))) {
      return reply.code(409).send({
        error: "Save your GDMS credentials in Settings before starting automation.",
      });
    }

    const jobData: WorkflowJobData = {
      runId: run.id,
      dealerId: body.dealerId,
      startedByUserId: credsUserId,
      operation: body.operation,
      sources: body.operation === "follow_up_skip" ? [] : body.sources,
      subSources: body.subSources,
    };

    try {
      await removeStaleBullJob(run.id);
      await workflowQueue.add("execute", jobData, { jobId: run.id });
      const job = await workflowQueue.getJob(run.id);
      if (!job) {
        await prisma.workflowRun.delete({ where: { id: run.id } });
        req.log.error({ runId: run.id }, "workflow job missing after enqueue");
        return reply.code(503).send({ error: "Could not queue this run. Try again." });
      }
      const jobState = await job.getState();
      req.log.info({ runId: run.id, jobState }, "workflow job enqueued");
    } catch (err) {
      await prisma.workflowRun.delete({ where: { id: run.id } }).catch(() => undefined);
      req.log.error({ runId: run.id, err }, "workflow enqueue failed");
      return reply.code(503).send({ error: "Could not queue this run. Try again." });
    }
    return run;
  });

  app.get("/v1/workflow-runs", { preHandler: authPreHandler }, async (req) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return [];
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) return [];
    await reconcileStaleWorkflowRunsForDealer(dealerId);
    return prisma.workflowRun.findMany({
      where: workflowRunScopeForActor(runActor(req), { dealerId }),
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  });

  app.get("/v1/workflow-runs/summary", { preHandler: authPreHandler }, async (req, reply) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const scope = workflowRunScopeForActor(runActor(req), { dealerId });
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [byStatus, recent, inFlight] = await Promise.all([
      prisma.workflowRun.groupBy({
        by: ["status"],
        where: { ...scope, startedAt: { gte: since } },
        _count: true,
      }),
      prisma.workflowRun.findFirst({
        where: scope,
        orderBy: { startedAt: "desc" },
      }),
      prisma.workflowRun.findFirst({
        where: {
          ...scope,
          status: { in: ["PENDING", "RUNNING", "PAUSED_OTP", "PAUSED_USER"] },
        },
        orderBy: { startedAt: "desc" },
      }),
    ]);

    return {
      periodDays: 7,
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count })),
      lastRun: recent,
      inFlight,
    };
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
      const runs = await prisma.workflowRun.findMany({
        where: {
          ...workflowRunScopeForActor(runActor(req), { dealerId }),
          status: { in: [...activeStatuses] },
        },
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
    if (!canAccessWorkflowRun(runActor(req), run)) {
      return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
    }
    const healed = await healWorkflowRunOnRead(run);
    const liveLogs = await getRunLogBuffer(healed.id);
    return { ...healed, liveLogs };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/requeue",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
      }
      if (run.status !== "PENDING") {
        return reply.code(409).send({ error: "Only queued runs can be re-queued." });
      }
      const result = await ensureWorkflowJobQueued(run, { force: true });
      if (!result.ok) {
        req.log.error({ runId: run.id, reason: result.reason }, "workflow requeue failed");
        return reply.code(503).send({ error: "Could not queue this run. Try again." });
      }
      req.log.info({ runId: run.id, jobState: result.jobState }, "workflow job requeued");
      return { ok: true, jobState: result.jobState };
    },
  );

  app.post<{ Params: { id: string } }>("/v1/workflow-runs/:id/otp", { preHandler: authPreHandler }, async (req, reply) => {
    const otp = z.object({ otp: z.string().min(4) }).parse(req.body).otp;
    const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
    if (!run) return reply.code(404).send({ error: "Not found" });
    if (!canAccessWorkflowRun(runActor(req), run)) {
      return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
    }
    if (run.status !== "PAUSED_OTP" && run.status !== "RUNNING") {
      return reply.code(409).send({ error: "This run is not waiting for OTP." });
    }
    await setOtpForRun(run.id, otp, run.dealerId);
    void fetch(`${automationBase()}/internal/notify-otp/${run.id}`, {
      method: "POST",
      headers: { "x-internal-secret": automationSecret() },
    }).catch(() => undefined);
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
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
      }
      const pauseMsg =
        "Paused from Live session — press Resume when you are ready to continue.";
      const stopMsg = "Stopped from Live session.";

      if (body.action === "pause") {
        if (run.status === "PENDING") {
          return reply.code(409).send({
            error: "This run is still queued. Use Stop to cancel it, or wait a few seconds.",
          });
        }
        if (run.status !== "RUNNING" && run.status !== "PAUSED_OTP") {
          return reply.code(409).send({ error: "This run cannot be paused right now." });
        }
        await setControl(run.id, "pause", "1");
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            status: "PAUSED_USER",
            errorMessage: pauseMsg,
            endedAt: new Date(),
          },
        });
        await publishWorkflowEvent({
          type: SocketEvents.WORKFLOW_PAUSED_USER,
          dealerId: run.dealerId,
          payload: { workflowRunId: run.id, message: pauseMsg },
        });
      }

      if (body.action === "resume") {
        if (run.status !== "PAUSED_USER" && run.status !== "FAILED") {
          return reply.code(409).send({ error: "This run is not paused. Nothing to resume." });
        }
        await setControl(run.id, "pause", "0");
        await setControl(run.id, "stop", "0");
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { status: "RUNNING", errorMessage: null, endedAt: null },
        });
        const resumeRun = await prisma.workflowRun.findUnique({ where: { id: run.id } });
        if (resumeRun) {
          const triggered = await triggerEnquiryResumeAfterControl(resumeRun);
          if (!triggered.ok) {
            req.log.warn({ runId: run.id, reason: triggered.reason }, "resume automation trigger failed");
            await publishWorkflowEvent({
              type: SocketEvents.LOG_LINE,
              dealerId: run.dealerId,
              payload: {
                workflowRunId: run.id,
                level: "warn",
                message: `${triggered.reason} Use Retry on Live session.`,
                ts: new Date().toISOString(),
              },
            });
          }
        }
      }

      if (body.action === "stop") {
        await setControl(run.id, "stop", "1");
        await setControl(run.id, "pause", "0");
        if (run.status === "PENDING") {
          await purgeBullJobArtifacts(run.id);
        } else {
          void fetch(`${automationBase()}/internal/force-stop/${run.id}`, {
            method: "POST",
            headers: { "x-internal-secret": automationSecret() },
          }).catch(() => undefined);
        }
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            status: "STOPPED",
            endedAt: new Date(),
            errorMessage: stopMsg,
          },
        });
        await publishWorkflowEvent({
          type: SocketEvents.LOG_LINE,
          dealerId: run.dealerId,
          payload: {
            workflowRunId: run.id,
            level: "info",
            message: stopMsg,
            ts: new Date().toISOString(),
          },
        });
        await reconcileStaleWorkflowRunsForDealer(run.dealerId);
      }

      await publishWorkflowEvent({
        type: SocketEvents.CONTROL_ACK,
        dealerId: run.dealerId,
        payload: { workflowRunId: run.id, action: body.action, ok: true },
      });
      const updated = await prisma.workflowRun.findUnique({ where: { id: run.id } });
      return { ok: true, action: body.action, status: updated?.status };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/workflow-runs/:id/gdms-logout",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const run = await prisma.workflowRun.findUnique({ where: { id: req.params.id } });
      if (!run) return reply.code(404).send({ error: "Not found" });
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
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
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
      }

      const params = automationRunParamsSchema.safeParse(run.runParams);
      if (
        !params.success ||
        (params.data.operation !== "enquiry_transfer" && params.data.operation !== "follow_up_skip")
      ) {
        return reply.code(409).send({
          error: "Resume is only available for enquiry transfer or follow up skip runs.",
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
          ...workflowRunScopeForActor(runActor(req), { dealerId: run.dealerId }),
          id: { not: run.id },
          status: { in: ["PENDING", "RUNNING", "PAUSED_OTP"] },
          runParams: { path: ["operation"], equals: params.data.operation },
        },
      });
      if (otherInFlight) {
        return reply.code(409).send({
          error:
            "You already have another automation running for this operation. Stop it first, then resume this session.",
          runId: otherInFlight.id,
        });
      }

      if (!run.startedByUserId) {
        return reply.code(409).send({ error: "This run has no linked user for GDMS credentials." });
      }
      const acc = await prisma.gdmsAccount.findUnique({ where: { userId: run.startedByUserId } });
      if (!acc) {
        return reply.code(409).send({ error: "GDMS credentials not configured for this user." });
      }

      const parseEnc = (stored: string): EncryptedPayload => JSON.parse(stored) as EncryptedPayload;
      const username = decryptSecret(parseEnc(acc.usernameCipher), env.CREDENTIALS_MASTER_KEY).trim();
      const password = decryptSecret(parseEnc(acc.passwordCipher), env.CREDENTIALS_MASTER_KEY).trim();

      const base =
        env.GDMS_BASE_URL ??
        process.env.GDMS_BASE_URL ??
        "https://ndms.hmil.net/cmm/cmmi/selectLoginMain.dms";
      const wfRow = await prisma.dealerWorkflow.findFirst({
        where: { dealerId: run.dealerId, name: params.data.operation, version: "1" },
      });
      const operation = params.data.operation;
      const operationWorkflow: WorkflowDefinition = wfRow?.definition
        ? (wfRow.definition as unknown as WorkflowDefinition)
        : operation === "follow_up_skip"
          ? followUpSkipWorkflow()
          : enquiryTransferWorkflow();
      const loginWorkflow = defaultLoginWorkflow(base);

      const resumePath =
        operation === "follow_up_skip"
          ? "internal/resume-follow-up-skip"
          : "internal/resume-enquiry-transfer";

      const res = await fetch(`${automationBase()}/${resumePath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": automationSecret(),
        },
        body: JSON.stringify({
          runId: run.id,
          dealerId: run.dealerId,
          startedByUserId: run.startedByUserId,
          gdmsUsername: username,
          gdmsPassword: password,
          loginWorkflow,
          operationWorkflow,
          operation,
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
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
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

      const runParams = automationRunParamsSchema.safeParse(run.runParams);
      const op = runParams.success ? runParams.data.operation : "enquiry_transfer";
      const retryPath =
        op === "follow_up_skip" ? "internal/retry-follow-up-skip" : "internal/retry-enquiry-transfer";

      const res = await fetch(`${automationBase()}/${retryPath}`, {
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
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
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

  app.get("/v1/gdms-browser-view", { preHandler: authPreHandler }, async (req, reply) => {
    if (!env.GDMS_REMOTE_VIEW) {
      return reply.code(404).send({ enabled: false });
    }
    const siteOrigin = env.CORS_ORIGIN.split(",")[0]?.trim() ?? "https://bot.edunexservices.in";
    const password = env.GDMS_VNC_PASSWORD ?? "gdms";
    const query = req.query as { workspace?: string; runId?: string };
    const workspaceId =
      query.workspace === "2" ? 2 : query.workspace === "1" ? 1 : undefined;

    let viewUserId = req.user!.sub;
    let operation = workspaceId === 2 ? "follow_up_skip" : "enquiry_transfer";

    if (query.runId) {
      const run = await prisma.workflowRun.findUnique({ where: { id: query.runId } });
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (!canAccessWorkflowRun(runActor(req), run)) {
        return reply.code(403).send({ error: "Forbidden — this run belongs to another user" });
      }
      if (!run.startedByUserId) {
        return reply.code(409).send({ error: "Run has no owner for browser view" });
      }
      viewUserId = run.startedByUserId;
      const params = automationRunParamsSchema.safeParse(run.runParams);
      if (params.success) operation = params.data.operation;
    }

    const buildUrl = (pathPrefix: string): string => {
      const q = new URLSearchParams({
        autoconnect: "true",
        resize: "scale",
        path: `${pathPrefix}/websockify`,
        password,
        reconnect: "true",
      });
      return `${siteOrigin}/${pathPrefix}/vnc.html?${q.toString()}`;
    };

    const pathForUser = (op: string) => vncPathPrefixForUserOperation(viewUserId, op);

    const workspaces = ([1, 2] as const).map((id) => {
      const op = id === 2 ? "follow_up_skip" : "enquiry_transfer";
      const pathPrefix = pathForUser(op);
      return {
        id,
        label: id === 2 ? "Follow Up Skip" : "Enquiry transfer",
        pathPrefix,
        url: buildUrl(pathPrefix),
      };
    });

    const opForWorkspace =
      workspaceId != null
        ? workspaceId === 2
          ? "follow_up_skip"
          : "enquiry_transfer"
        : operation;
    const primaryPrefix = pathForUser(opForWorkspace);

    return {
      enabled: true,
      workspace: workspaceId ?? vncWorkspaceForOperation(operation),
      url: buildUrl(primaryPrefix),
      pathPrefix: primaryPrefix,
      workspaces,
    };
  });
}

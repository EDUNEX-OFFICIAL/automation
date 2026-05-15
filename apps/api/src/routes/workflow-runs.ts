import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canStartWorkflow, canAccessDealer } from "@gdms/auth";
import { workflowQueue } from "../queue.js";
import { setOtpForRun, setControl } from "../redis.js";

const startSchema = z.object({
  dealerId: z.string(),
  kind: z.enum(["gdms_login", "inquiry_fetch", "inquiry_transfer", "status_update"]),
});

export async function registerWorkflowRunRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/workflow-runs", { preHandler: authPreHandler }, async (req, reply) => {
    if (!canStartWorkflow(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = startSchema.parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const run = await prisma.workflowRun.create({
      data: {
        dealerId: body.dealerId,
        status: "PENDING",
        currentStep: body.kind,
      },
    });
    await workflowQueue.add(
      "execute",
      { runId: run.id, dealerId: body.dealerId, kind: body.kind },
      { jobId: run.id },
    );
    return run;
  });

  app.get("/v1/workflow-runs", { preHandler: authPreHandler }, async (req) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return [];
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) return [];
    return prisma.workflowRun.findMany({
      where: { dealerId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  });

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
    await setOtpForRun(run.id, otp);
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
}

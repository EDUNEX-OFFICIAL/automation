import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer } from "@gdms/auth";

const upsertWorkflowSchema = z.object({
  dealerId: z.string(),
  name: z.string().min(1),
  version: z.string().default("1"),
  definition: z.any(),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workflows", { preHandler: authPreHandler }, async (req, reply) => {
    const dealerId =
      (req.query as { dealerId?: string }).dealerId ?? req.user!.dealerId ?? undefined;
    if (!dealerId) return reply.code(400).send({ error: "dealerId required" });
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    return prisma.dealerWorkflow.findMany({ where: { dealerId }, orderBy: { updatedAt: "desc" } });
  });

  app.post("/v1/workflows", { preHandler: authPreHandler }, async (req, reply) => {
    const body = upsertWorkflowSchema.parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const row = await prisma.dealerWorkflow.upsert({
      where: {
        dealerId_name_version: {
          dealerId: body.dealerId,
          name: body.name,
          version: body.version,
        },
      },
      create: {
        dealerId: body.dealerId,
        name: body.name,
        version: body.version,
        definition: body.definition,
      },
      update: { definition: body.definition },
    });
    return row;
  });
}

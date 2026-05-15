import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer } from "@gdms/auth";

const createDealerSchema = z.object({
  name: z.string().min(1),
});

export async function registerDealerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/dealers", { preHandler: authPreHandler }, async (req, reply) => {
    if (req.user!.role !== "SUPER_ADMIN") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const body = createDealerSchema.parse(req.body);
    const dealer = await prisma.dealer.create({ data: { name: body.name } });
    return dealer;
  });

  app.get("/v1/dealers", { preHandler: authPreHandler }, async (req) => {
    if (req.user!.role === "SUPER_ADMIN") {
      return prisma.dealer.findMany({ orderBy: { createdAt: "desc" } });
    }
    if (!req.user!.dealerId) return [];
    const d = await prisma.dealer.findUnique({ where: { id: req.user!.dealerId! } });
    return d ? [d] : [];
  });

  app.get("/v1/dealers/:id", { preHandler: authPreHandler }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!canAccessDealer(req.user!.dealerId, id, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const dealer = await prisma.dealer.findUnique({ where: { id } });
    if (!dealer) return reply.code(404).send({ error: "Not found" });
    return dealer;
  });
}

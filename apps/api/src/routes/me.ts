import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/me", { preHandler: authPreHandler }, async (req, reply) => {
    const u = req.user!;
    const user = await prisma.user.findUnique({ where: { id: u.sub } });
    if (!user) return reply.code(404).send({ error: "Not found" });
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      dealerId: user.dealerId,
    };
  });
}

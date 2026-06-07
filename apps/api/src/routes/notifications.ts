import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/notifications", { preHandler: authPreHandler }, async (req) => {
    const userId = req.user!.sub;
    const rows = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const unread = await prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { items: rows, unreadCount: unread };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/notifications/:id/read",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const row = await prisma.notification.findUnique({ where: { id: req.params.id } });
      if (!row || row.userId !== req.user!.sub) {
        return reply.code(404).send({ error: "Not found" });
      }
      await prisma.notification.update({
        where: { id: row.id },
        data: { readAt: new Date() },
      });
      return { ok: true };
    },
  );

  app.post("/v1/notifications/read-all", { preHandler: authPreHandler }, async (req) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/notifications/:id",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const row = await prisma.notification.findUnique({ where: { id: req.params.id } });
      if (!row || row.userId !== req.user!.sub) {
        return reply.code(404).send({ error: "Not found" });
      }
      await prisma.notification.delete({ where: { id: row.id } });
      return { ok: true };
    },
  );
}

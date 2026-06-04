import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer, canManageDealerUsers } from "@gdms/auth";

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { dealerId: string } }>(
    "/v1/dealers/:dealerId/analytics",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const { dealerId } = req.params;
      const role = req.user!.role;
      if (!canAccessDealer(req.user!.dealerId, dealerId, role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!canManageDealerUsers(role) && role !== "TEAM_LEADER" && role !== "SALES_CONSULTANT") {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [runsByStatus, inquiryByCategory, totalUsers, gdmsConfigured, lastRun] =
        await Promise.all([
          prisma.workflowRun.groupBy({
            by: ["status"],
            where: { dealerId, startedAt: { gte: since } },
            _count: true,
          }),
          prisma.inquiry.groupBy({
            by: ["category"],
            where: { dealerId },
            _count: true,
          }),
          prisma.user.count({ where: { dealerId, isActive: true } }),
          prisma.gdmsAccount.count({
            where: { user: { dealerId, isActive: true } },
          }),
          prisma.workflowRun.findFirst({
            where: { dealerId },
            orderBy: { startedAt: "desc" },
            select: {
              id: true,
              status: true,
              startedAt: true,
              endedAt: true,
              runParams: true,
            },
          }),
        ]);

      return {
        periodDays: 7,
        runsByStatus: runsByStatus.map((r) => ({ status: r.status, count: r._count })),
        leadsByCategory: inquiryByCategory.map((r) => ({
          category: r.category,
          count: r._count,
        })),
        activeUsers: totalUsers,
        gdmsAccountsConfigured: gdmsConfigured,
        lastRun,
      };
    },
  );

  app.get<{ Params: { dealerId: string } }>(
    "/v1/dealers/:dealerId/health",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const { dealerId } = req.params;
      if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const dealer = await prisma.dealer.findUnique({
        where: { id: dealerId },
        include: {
          _count: { select: { users: true, inquiries: true, runs: true } },
          automationSettings: true,
        },
      });
      if (!dealer) return reply.code(404).send({ error: "Not found" });

      const lastRun = await prisma.workflowRun.findFirst({
        where: { dealerId },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true },
      });

      const gdmsCount = await prisma.gdmsAccount.count({
        where: { user: { dealerId, isActive: true } },
      });

      return {
        dealerId: dealer.id,
        name: dealer.name,
        isActive: dealer.isActive,
        userCount: dealer._count.users,
        inquiryCount: dealer._count.inquiries,
        runCount: dealer._count.runs,
        followUpSkipEnabled: dealer.automationSettings?.followUpSkipEnabled ?? false,
        gdmsAccountsConfigured: gdmsCount,
        lastRun,
      };
    },
  );
}

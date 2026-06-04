import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { canRunEnquiryTransfer } from "@gdms/auth";
import { prisma } from "../prisma.js";
import { resolveEffectiveTeamType } from "../lib/team-type.js";

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/me", { preHandler: authPreHandler }, async (req, reply) => {
    const u = req.user!;
    const user = await prisma.user.findUnique({
      where: { id: u.sub },
      include: { reportsTo: { select: { id: true, username: true, teamType: true } } },
    });
    if (!user || !user.isActive) return reply.code(404).send({ error: "Not found" });

    const effectiveTeamType = await resolveEffectiveTeamType(user.id);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      displayLabel: user.displayName?.trim() || user.username,
      avatarUrl: user.avatarUrl,
      email: user.email,
      role: user.role,
      dealerId: user.dealerId,
      reportsToUserId: user.reportsToUserId,
      teamType: user.teamType,
      effectiveTeamType,
      canRunEnquiryTransfer: canRunEnquiryTransfer(effectiveTeamType),
      reportsTo: user.reportsTo
        ? {
            id: user.reportsTo.id,
            username: user.reportsTo.username,
            teamType: user.reportsTo.teamType,
          }
        : null,
    };
  });
}

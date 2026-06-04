import type { TeamType } from "@gdms/auth";
import { prisma } from "../prisma.js";

export async function resolveEffectiveTeamType(userId: string): Promise<TeamType | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, teamType: true, reportsToUserId: true },
  });
  if (!user) return null;
  if (user.role === "TEAM_LEADER") return user.teamType;
  if (user.role === "SALES_CONSULTANT" && user.reportsToUserId) {
    const tl = await prisma.user.findUnique({
      where: { id: user.reportsToUserId },
      select: { teamType: true, role: true },
    });
    if (tl?.role === "TEAM_LEADER") return tl.teamType;
  }
  return null;
}

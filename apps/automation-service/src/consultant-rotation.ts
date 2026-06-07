import type { PrismaClient } from "@gdms/database";
import type { Redis } from "ioredis";

export type ConsultantRotationState = {
  teamLeaderUserId: string;
  consultants: string[];
};

export type ConsultantRotationContext = {
  startedByUserId: string;
  rotation?: ConsultantRotationState;
};

const ROLE_TEAM_LEADER = "TEAM_LEADER";
const ROLE_SALES_CONSULTANT = "SALES_CONSULTANT";

const redisKey = (teamLeaderUserId: string) => `gdms:tl:${teamLeaderUserId}:consultant_rotation`;

/** GDMS dropdown label for an SC (must match CRM display name when set). */
export function salesConsultantGdmsLabel(user: {
  displayName: string | null;
  username: string;
}): string {
  const name = user.displayName?.trim();
  return name || user.username;
}

type StarterRow = {
  role: string;
  reportsToUserId: string | null;
  isActive: boolean;
};

type TlRow = {
  role: string;
  isActive: boolean;
};

type ScLabelRow = {
  id: string;
  displayName: string | null;
  username: string;
  reportsToUserId: string | null;
};

function labelMatchesGdms(candidate: string, label: string): boolean {
  const a = candidate.trim().toLowerCase();
  const b = label.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const aWords = a.split(/\s+/).slice(0, 2).join(" ");
  const bWords = b.split(/\s+/).slice(0, 2).join(" ");
  if (aWords && bWords && (a.includes(bWords) || b.includes(aWords))) return true;
  return false;
}

/** Team Leader id for rotation: TL who started the run, or SC's reportsTo TL. */
export async function resolveTeamLeaderUserId(
  prisma: PrismaClient,
  startedByUserId: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<StarterRow[]>`
    SELECT role::text AS role, "reportsToUserId", "isActive"
    FROM "User"
    WHERE id = ${startedByUserId}
    LIMIT 1
  `;
  const user = rows[0];
  if (!user?.isActive) {
    throw new Error("Enquiry transfer: starter user not found or inactive.");
  }
  if (user.role === ROLE_TEAM_LEADER) return startedByUserId;
  if (user.role === ROLE_SALES_CONSULTANT) {
    if (!user.reportsToUserId) {
      throw new Error(
        "Sales Consultant has no Team Leader — assign reports-to in My team before enquiry transfer.",
      );
    }
    const tlRows = await prisma.$queryRaw<TlRow[]>`
      SELECT role::text AS role, "isActive"
      FROM "User"
      WHERE id = ${user.reportsToUserId}
      LIMIT 1
    `;
    const tl = tlRows[0];
    if (!tl || tl.role !== ROLE_TEAM_LEADER || !tl.isActive) {
      throw new Error("Invalid Team Leader for sales consultant rotation.");
    }
    return user.reportsToUserId;
  }
  throw new Error(
    "Enquiry transfer rotation requires a Digital Team Leader or their Sales Consultant to start the run.",
  );
}

export async function loadTeamSalesConsultantLabels(
  prisma: PrismaClient,
  teamLeaderUserId: string,
): Promise<string[]> {
  const scs = await loadTeamSalesConsultants(prisma, teamLeaderUserId);
  return scs
    .map((u) => salesConsultantGdmsLabel(u))
    .filter((label: string) => label.length > 0);
}

export async function loadTeamSalesConsultants(
  prisma: PrismaClient,
  teamLeaderUserId: string,
): Promise<ScLabelRow[]> {
  return prisma.$queryRaw<ScLabelRow[]>`
    SELECT id, "displayName", username, "reportsToUserId"
    FROM "User"
    WHERE "reportsToUserId" = ${teamLeaderUserId}
      AND role = ${ROLE_SALES_CONSULTANT}::"UserRole"
      AND "isActive" = true
    ORDER BY "displayName" ASC NULLS LAST, username ASC
  `;
}

export async function loadDealerSalesConsultants(
  prisma: PrismaClient,
  dealerId: string,
): Promise<ScLabelRow[]> {
  return prisma.$queryRaw<ScLabelRow[]>`
    SELECT id, "displayName", username, "reportsToUserId"
    FROM "User"
    WHERE "dealerId" = ${dealerId}
      AND role = ${ROLE_SALES_CONSULTANT}::"UserRole"
      AND "isActive" = true
    ORDER BY "displayName" ASC NULLS LAST, username ASC
  `;
}

/** Match GDMS SC label to User.id within team or whole dealer. */
export async function resolveScUserIdFromLabel(
  prisma: PrismaClient,
  dealerId: string,
  teamLeaderUserId: string | null,
  label: string,
): Promise<string | null> {
  const trimmed = label.trim();
  if (!trimmed) return null;

  const pool = teamLeaderUserId
    ? await loadTeamSalesConsultants(prisma, teamLeaderUserId)
    : await loadDealerSalesConsultants(prisma, dealerId);

  for (const sc of pool) {
    if (labelMatchesGdms(salesConsultantGdmsLabel(sc), trimmed)) return sc.id;
  }
  for (const sc of pool) {
    if (labelMatchesGdms(sc.username, trimmed)) return sc.id;
  }
  return null;
}

async function ensureRotationPool(
  prisma: PrismaClient,
  ctx: ConsultantRotationContext,
): Promise<ConsultantRotationState> {
  if (ctx.rotation) return ctx.rotation;
  const teamLeaderUserId = await resolveTeamLeaderUserId(prisma, ctx.startedByUserId);
  const consultants = await loadTeamSalesConsultantLabels(prisma, teamLeaderUserId);
  if (consultants.length === 0) {
    throw new Error(
      "No active Sales Consultants under this Team Leader. Add SCs in My team before enquiry transfer.",
    );
  }
  ctx.rotation = { teamLeaderUserId, consultants };
  return ctx.rotation;
}

/** Atomic round-robin among SCs under the run starter's Team Leader. */
export async function pickNextSalesConsultant(
  prisma: PrismaClient,
  redis: Redis,
  ctx: ConsultantRotationContext,
): Promise<string> {
  const { teamLeaderUserId, consultants } = await ensureRotationPool(prisma, ctx);
  const seq = await redis.incr(redisKey(teamLeaderUserId));
  const index = (seq - 1) % consultants.length;
  return consultants[index]!;
}

/** @deprecated Use pickNextSalesConsultant with rotation context. */
export async function nextSalesConsultant(
  prisma: PrismaClient,
  redis: Redis,
  ctx: ConsultantRotationContext,
): Promise<string> {
  return pickNextSalesConsultant(prisma, redis, ctx);
}

/** No-op: rotation advances in pickNextSalesConsultant via INCR. */
export async function advanceConsultantRotation(_redis: Redis, _teamLeaderUserId: string): Promise<void> {}

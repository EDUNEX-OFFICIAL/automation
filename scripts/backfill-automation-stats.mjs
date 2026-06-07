#!/usr/bin/env node
/**
 * Backfill AutomationStatEvent from WorkflowRuns with metrics.processed > 0.
 * Enquiry transfers are assigned to SCs via round-robin (same order as live rotation).
 *
 * Usage: DATABASE_URL=... node scripts/backfill-automation-stats.mjs
 */
import { createPrisma } from "@gdms/database";
import { parseRunMetrics, automationRunParamsSchema } from "@gdms/shared";

const prisma = createPrisma();

function gdmsLabel(user) {
  return user.displayName?.trim() || user.username;
}

async function resolveTeamLeaderUserId(starterId) {
  const starter = await prisma.user.findUnique({
    where: { id: starterId },
    select: { role: true, reportsToUserId: true, isActive: true },
  });
  if (!starter?.isActive) return null;
  if (starter.role === "TEAM_LEADER") return starterId;
  if (starter.role === "SALES_CONSULTANT" && starter.reportsToUserId) {
    return starter.reportsToUserId;
  }
  return null;
}

async function loadTeamConsultants(teamLeaderUserId) {
  return prisma.user.findMany({
    where: {
      reportsToUserId: teamLeaderUserId,
      role: "SALES_CONSULTANT",
      isActive: true,
    },
    orderBy: [{ displayName: "asc" }, { username: "asc" }],
    select: { id: true, displayName: true, username: true },
  });
}

async function main() {
  const runs = await prisma.workflowRun.findMany({
    where: {
      status: { in: ["COMPLETED", "STOPPED"] },
      startedByUserId: { not: null },
    },
    select: {
      id: true,
      dealerId: true,
      startedByUserId: true,
      runParams: true,
      startedAt: true,
    },
    orderBy: { startedAt: "asc" },
  });

  /** Per TL round-robin sequence (matches Redis INCR from first pick). */
  const rotationSeqByTl = new Map();
  let created = 0;
  let skipped = 0;

  for (const run of runs) {
    const metrics = parseRunMetrics(run.runParams);
    const processed = metrics?.processed ?? 0;
    if (processed < 1) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.automationStatEvent.count({
      where: { workflowRunId: run.id },
    });
    if (existing > 0) {
      skipped += 1;
      continue;
    }

    const params = automationRunParamsSchema.safeParse(run.runParams);
    const operation =
      params.success && params.data.operation === "follow_up_skip"
        ? "follow_up_skip"
        : "enquiry_transfer";

    const starterId = run.startedByUserId;
    if (!starterId) continue;

    const teamLeaderUserId = await resolveTeamLeaderUserId(starterId);
    const consultants =
      teamLeaderUserId && operation === "enquiry_transfer"
        ? await loadTeamConsultants(teamLeaderUserId)
        : [];

    let seq = teamLeaderUserId ? (rotationSeqByTl.get(teamLeaderUserId) ?? 0) : 0;

    const batch = [];
    for (let i = 0; i < processed; i++) {
      seq += 1;
      let salesConsultantUserId = null;
      let salesConsultantLabel = "Unknown (historical)";

      if (consultants.length > 0) {
        const sc = consultants[(seq - 1) % consultants.length];
        salesConsultantUserId = sc.id;
        salesConsultantLabel = gdmsLabel(sc);
      }

      batch.push({
        dealerId: run.dealerId,
        workflowRunId: run.id,
        operation,
        startedByUserId: starterId,
        teamLeaderUserId,
        salesConsultantUserId,
        salesConsultantLabel,
        occurredAt: run.startedAt,
      });
    }

    if (teamLeaderUserId) {
      rotationSeqByTl.set(teamLeaderUserId, seq);
    }

    await prisma.automationStatEvent.createMany({ data: batch });
    created += batch.length;
    console.log(`Backfilled ${batch.length} events for run ${run.id} (${operation})`);
  }

  console.log(`Done. Created ${created} events, skipped ${skipped} runs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

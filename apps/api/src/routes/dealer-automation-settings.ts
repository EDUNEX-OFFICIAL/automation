import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import { canAccessDealer } from "@gdms/auth";
import { dealerAutomationSettingsSchema } from "@gdms/shared";
import {
  clearFollowUpSkipSchedulerKeys,
  enqueueScheduledFollowUpSkip,
  triggerFollowUpSkipIfDueNow,
} from "../lib/follow-up-skip-scheduler.js";
import { stopFollowUpSkipRunsForDealer } from "../lib/stop-workflow-run.js";

export async function registerDealerAutomationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/dealers/:dealerId/automation-settings", { preHandler: authPreHandler }, async (req, reply) => {
    const { dealerId } = req.params as { dealerId: string };
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const row = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });
    return {
      followUpSkipEnabled: row?.followUpSkipEnabled ?? false,
      followUpSkipStartTime: row?.followUpSkipStartTime ?? null,
    };
  });

  app.post("/v1/dealers/:dealerId/automation-settings/run-now", { preHandler: authPreHandler }, async (req, reply) => {
    const { dealerId } = req.params as { dealerId: string };
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const row = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });
    if (!row?.followUpSkipEnabled || !row.followUpSkipStartTime) {
      return reply.code(409).send({ error: "Enable Follow Up Skip and set a daily time in Settings first." });
    }

    await clearFollowUpSkipSchedulerKeys(dealerId);
    const result = await enqueueScheduledFollowUpSkip(dealerId, row.followUpSkipStartTime);
    if (!result.ok) {
      return reply.code(409).send({ error: result.reason });
    }
    return { ok: true, runId: result.runId, alreadyRunning: result.alreadyRunning ?? false };
  });

  app.put("/v1/dealers/:dealerId/automation-settings", { preHandler: authPreHandler }, async (req, reply) => {
    const { dealerId } = req.params as { dealerId: string };
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    let body: { followUpSkipEnabled: boolean; followUpSkipStartTime?: string | null };
    try {
      body = dealerAutomationSettingsSchema.parse(req.body);
    } catch {
      return reply.code(400).send({ error: "Invalid automation settings" });
    }

    const prev = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });

    const row = await prisma.dealerAutomationSettings.upsert({
      where: { dealerId },
      create: {
        dealerId,
        followUpSkipEnabled: body.followUpSkipEnabled,
        followUpSkipStartTime: body.followUpSkipEnabled ? (body.followUpSkipStartTime ?? null) : null,
      },
      update: {
        followUpSkipEnabled: body.followUpSkipEnabled,
        followUpSkipStartTime: body.followUpSkipEnabled ? (body.followUpSkipStartTime ?? null) : null,
      },
    });

    const scheduleChanged =
      prev?.followUpSkipStartTime !== row.followUpSkipStartTime ||
      prev?.followUpSkipEnabled !== row.followUpSkipEnabled;
    if (scheduleChanged) {
      await clearFollowUpSkipSchedulerKeys(dealerId);
    }

    let triggeredRunId: string | undefined;
    if (row.followUpSkipEnabled && row.followUpSkipStartTime) {
      const immediate = await triggerFollowUpSkipIfDueNow(dealerId, row.followUpSkipStartTime);
      if (immediate?.ok && immediate.runId && !immediate.alreadyRunning) {
        triggeredRunId = immediate.runId;
      }
    }

    let stoppedRunIds: string[] = [];
    if (!body.followUpSkipEnabled) {
      stoppedRunIds = await stopFollowUpSkipRunsForDealer(dealerId);
      if (stoppedRunIds.length > 0) {
        req.log.info({ dealerId, stoppedRunIds }, "follow_up_skip force-stopped after settings toggle off");
      }
    }

    return {
      followUpSkipEnabled: row.followUpSkipEnabled,
      followUpSkipStartTime: row.followUpSkipStartTime,
      stoppedRunIds,
      triggeredRunId,
    };
  });
}

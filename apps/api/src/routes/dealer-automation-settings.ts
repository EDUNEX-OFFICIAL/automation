import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { prisma } from "../prisma.js";
import {
  canAccessDealer,
  canEditDealerAutomationSettings,
  canEditRemarkAutomationSettings,
} from "@gdms/auth";
import {
  dealerAutomationSettingsSchema,
  normalizeDealerAutomationSettingsInput,
  normalizeEnquiryRemarkRules,
  normalizeFollowUpSkipRemarkBases,
  normalizeRemarkBase,
  resolveEnquiryRemarkBase,
  formatAutomationRemark,
  type DealerAutomationSettingsResponse,
  type EnquiryRemarkRule,
} from "@gdms/shared";
import {
  clearFollowUpSkipSchedulerKeys,
  enqueueScheduledFollowUpSkip,
  triggerFollowUpSkipIfDueNow,
} from "../lib/follow-up-skip-scheduler.js";
import { stopFollowUpSkipRunsForDealer } from "../lib/stop-workflow-run.js";
import { writeAuditEvent } from "../lib/audit.js";

function parseEnquiryRemarkRulesJson(raw: unknown): EnquiryRemarkRule[] {
  if (!Array.isArray(raw)) return [];
  const parsed: EnquiryRemarkRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.source !== "string" || typeof o.remarkBase !== "string") continue;
    parsed.push({
      source: o.source as EnquiryRemarkRule["source"],
      subSource: typeof o.subSource === "string" ? o.subSource : undefined,
      remarkBase: o.remarkBase,
    });
  }
  return normalizeEnquiryRemarkRules(parsed);
}

function parseFollowUpSkipRemarkBasesJson(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return normalizeFollowUpSkipRemarkBases(raw.filter((x): x is string => typeof x === "string"));
}

function toSettingsResponse(
  row: {
    followUpSkipEnabled: boolean;
    followUpSkipStartTime: string | null;
    defaultEnquiryRemarkBase: string;
    enquiryRemarkRules: unknown;
    followUpSkipRemarkBases: unknown;
    ollamaModel?: string | null;
    enquiryTransferEnabled?: boolean;
    enquiryTransferStartTime?: string | null;
    lastScheduledRunId?: string | null;
    lastScheduledRunAt?: Date | null;
  } | null,
  canEditRemarks: boolean,
): DealerAutomationSettingsResponse {
  return {
    followUpSkipEnabled: row?.followUpSkipEnabled ?? false,
    followUpSkipStartTime: row?.followUpSkipStartTime ?? null,
    defaultEnquiryRemarkBase: normalizeRemarkBase(row?.defaultEnquiryRemarkBase ?? "Call Back"),
    enquiryRemarkRules: parseEnquiryRemarkRulesJson(row?.enquiryRemarkRules),
    followUpSkipRemarkBases: parseFollowUpSkipRemarkBasesJson(row?.followUpSkipRemarkBases),
    canEditRemarks,
    ollamaModel: row?.ollamaModel ?? null,
    enquiryTransferEnabled: row?.enquiryTransferEnabled ?? false,
    enquiryTransferStartTime: row?.enquiryTransferStartTime ?? null,
    lastScheduledRunId: row?.lastScheduledRunId ?? null,
    lastScheduledRunAt: row?.lastScheduledRunAt?.toISOString() ?? null,
  };
}

export async function registerDealerAutomationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/dealers/:dealerId/automation-settings", { preHandler: authPreHandler }, async (req, reply) => {
    const { dealerId } = req.params as { dealerId: string };
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const row = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });
    return toSettingsResponse(row, canEditRemarkAutomationSettings(req.user!.role));
  });

  app.post(
    "/v1/dealers/:dealerId/automation-settings/preview-remark",
    { preHandler: authPreHandler },
    async (req, reply) => {
      const { dealerId } = req.params as { dealerId: string };
      if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const body = z
        .object({
          source: z.string(),
          subSource: z.string().optional(),
        })
        .parse(req.body);

      const row = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });
      const base = resolveEnquiryRemarkBase(
        parseEnquiryRemarkRulesJson(row?.enquiryRemarkRules),
        normalizeRemarkBase(row?.defaultEnquiryRemarkBase ?? "Call Back"),
        body.source,
        body.subSource,
      );
      return { base, formatted: formatAutomationRemark(base) };
    },
  );

  app.post("/v1/dealers/:dealerId/automation-settings/run-now", { preHandler: authPreHandler }, async (req, reply) => {
    const { dealerId } = req.params as { dealerId: string };
    if (!canEditDealerAutomationSettings(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
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
    if (!canEditDealerAutomationSettings(req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    if (!canAccessDealer(req.user!.dealerId, dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    let body: z.infer<typeof dealerAutomationSettingsSchema>;
    try {
      body = dealerAutomationSettingsSchema.parse(req.body);
    } catch {
      return reply.code(400).send({ error: "Invalid automation settings" });
    }

    const canEditRemarks = canEditRemarkAutomationSettings(req.user!.role);
    const prev = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });

    const normalized = normalizeDealerAutomationSettingsInput(body);

    const scheduleOnly = {
      followUpSkipEnabled: normalized.followUpSkipEnabled,
      followUpSkipStartTime: normalized.followUpSkipStartTime,
      ollamaModel: normalized.ollamaModel ?? prev?.ollamaModel ?? null,
      enquiryTransferEnabled: normalized.enquiryTransferEnabled ?? prev?.enquiryTransferEnabled ?? false,
      enquiryTransferStartTime:
        normalized.enquiryTransferStartTime ?? prev?.enquiryTransferStartTime ?? null,
    };

    let remarkFields: {
      defaultEnquiryRemarkBase: string;
      enquiryRemarkRules: EnquiryRemarkRule[];
      followUpSkipRemarkBases: string[];
    };
    if (canEditRemarks) {
      remarkFields = {
        defaultEnquiryRemarkBase: normalized.defaultEnquiryRemarkBase,
        enquiryRemarkRules: normalized.enquiryRemarkRules,
        followUpSkipRemarkBases: normalized.followUpSkipRemarkBases,
      };
    } else {
      remarkFields = {
        defaultEnquiryRemarkBase: normalizeRemarkBase(prev?.defaultEnquiryRemarkBase ?? "Call Back"),
        enquiryRemarkRules: parseEnquiryRemarkRulesJson(prev?.enquiryRemarkRules),
        followUpSkipRemarkBases: parseFollowUpSkipRemarkBasesJson(prev?.followUpSkipRemarkBases),
      };
    }

    const row = await prisma.dealerAutomationSettings.upsert({
      where: { dealerId },
      create: {
        dealerId,
        ...scheduleOnly,
        ...remarkFields,
        enquiryRemarkRules: remarkFields.enquiryRemarkRules as object,
        followUpSkipRemarkBases: remarkFields.followUpSkipRemarkBases as object,
      },
      update: {
        ...scheduleOnly,
        ...remarkFields,
        enquiryRemarkRules: remarkFields.enquiryRemarkRules as object,
        followUpSkipRemarkBases: remarkFields.followUpSkipRemarkBases as object,
      },
    });

    await writeAuditEvent({
      dealerId,
      actorUserId: req.user!.sub,
      action: "automation_settings_updated",
      entityType: "DealerAutomationSettings",
      entityId: dealerId,
      payload: {
        followUpSkipEnabled: row.followUpSkipEnabled,
        enquiryTransferEnabled: row.enquiryTransferEnabled,
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
        await prisma.dealerAutomationSettings.update({
          where: { dealerId },
          data: { lastScheduledRunId: immediate.runId, lastScheduledRunAt: new Date() },
        });
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
      ...toSettingsResponse(row, canEditRemarks),
      stoppedRunIds,
      triggeredRunId,
    };
  });
}

import { createPrisma } from "@gdms/database";
import {
  DEFAULT_DEALER_REMARK_CONFIG,
  normalizeEnquiryRemarkRules,
  normalizeFollowUpSkipRemarkBases,
  normalizeRemarkBase,
  type DealerRemarkConfig,
  type EnquiryRemarkRule,
} from "@gdms/shared";

const prisma = createPrisma();

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

export async function loadDealerRemarkConfig(dealerId: string): Promise<DealerRemarkConfig> {
  const row = await prisma.dealerAutomationSettings.findUnique({ where: { dealerId } });
  if (!row) return { ...DEFAULT_DEALER_REMARK_CONFIG };
  return {
    defaultEnquiryRemarkBase: normalizeRemarkBase(row.defaultEnquiryRemarkBase ?? "Call Back"),
    enquiryRemarkRules: parseEnquiryRemarkRulesJson(row.enquiryRemarkRules),
    followUpSkipRemarkBases: parseFollowUpSkipRemarkBasesJson(row.followUpSkipRemarkBases),
  };
}

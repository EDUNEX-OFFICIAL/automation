import { z } from "zod";
import {
  defaultEnquiryRemarkBaseSchema,
  enquiryRemarkRulesSchema,
  followUpSkipRemarkBasesSchema,
  normalizeEnquiryRemarkRules,
  normalizeFollowUpSkipRemarkBases,
  normalizeRemarkBase,
  type EnquiryRemarkRule,
} from "./automation-remarks.js";

const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const dealerAutomationSettingsSchema = z
  .object({
    followUpSkipEnabled: z.boolean(),
    followUpSkipStartTime: z.string().regex(timeRe).nullable().optional(),
    defaultEnquiryRemarkBase: defaultEnquiryRemarkBaseSchema.optional(),
    enquiryRemarkRules: enquiryRemarkRulesSchema.optional(),
    followUpSkipRemarkBases: followUpSkipRemarkBasesSchema.optional(),
    ollamaModel: z.string().max(64).nullable().optional(),
    enquiryTransferEnabled: z.boolean().optional(),
    enquiryTransferStartTime: z.string().regex(timeRe).nullable().optional(),
    lostInquiryEnabled: z.boolean().optional(),
    lostInquiryStartTime: z.string().regex(timeRe).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.followUpSkipEnabled && !data.followUpSkipStartTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Start time is required when Follow Up Skip is enabled",
        path: ["followUpSkipStartTime"],
      });
    }
    if (data.lostInquiryEnabled && !data.lostInquiryStartTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Start time is required when Lost Inquiry is enabled",
        path: ["lostInquiryStartTime"],
      });
    }
  });

export type DealerAutomationSettingsPayload = z.infer<typeof dealerAutomationSettingsSchema>;

export type DealerAutomationSettingsResponse = {
  followUpSkipEnabled: boolean;
  followUpSkipStartTime: string | null;
  defaultEnquiryRemarkBase: string;
  enquiryRemarkRules: EnquiryRemarkRule[];
  followUpSkipRemarkBases: string[];
  canEditRemarks: boolean;
  ollamaModel: string | null;
  enquiryTransferEnabled: boolean;
  enquiryTransferStartTime: string | null;
  lostInquiryEnabled: boolean;
  lostInquiryStartTime: string | null;
  lastScheduledRunId: string | null;
  lastScheduledRunAt: string | null;
};

export function normalizeDealerAutomationSettingsInput(
  body: DealerAutomationSettingsPayload,
): {
  followUpSkipEnabled: boolean;
  followUpSkipStartTime: string | null;
  defaultEnquiryRemarkBase: string;
  enquiryRemarkRules: EnquiryRemarkRule[];
  followUpSkipRemarkBases: string[];
  ollamaModel?: string | null;
  enquiryTransferEnabled?: boolean;
  enquiryTransferStartTime?: string | null;
  lostInquiryEnabled?: boolean;
  lostInquiryStartTime?: string | null;
} {
  return {
    followUpSkipEnabled: body.followUpSkipEnabled,
    followUpSkipStartTime: body.followUpSkipEnabled ? (body.followUpSkipStartTime ?? null) : null,
    defaultEnquiryRemarkBase: normalizeRemarkBase(body.defaultEnquiryRemarkBase ?? "Call Back"),
    enquiryRemarkRules: normalizeEnquiryRemarkRules(body.enquiryRemarkRules ?? []),
    followUpSkipRemarkBases: normalizeFollowUpSkipRemarkBases(body.followUpSkipRemarkBases ?? []),
    ollamaModel: body.ollamaModel?.trim() || null,
    enquiryTransferEnabled: body.enquiryTransferEnabled ?? false,
    enquiryTransferStartTime:
      body.enquiryTransferEnabled && body.enquiryTransferStartTime
        ? body.enquiryTransferStartTime
        : null,
    lostInquiryEnabled: body.lostInquiryEnabled ?? false,
    lostInquiryStartTime:
      body.lostInquiryEnabled && body.lostInquiryStartTime ? body.lostInquiryStartTime : null,
  };
}

export function parseIstTimeHHmm(value: string): { hour: number; minute: number } | null {
  const m = timeRe.exec(value.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** True when IST clock has reached the daily Follow Up Skip start time (same day). */
export function isFollowUpSkipScheduleDue(startTime: string, now = new Date()): boolean {
  const parsed = parseIstTimeHHmm(startTime);
  if (!parsed) return false;
  const { hour, minute } = nowIstParts(now);
  const nowMins = hour * 60 + minute;
  const schedMins = parsed.hour * 60 + parsed.minute;
  return nowMins >= schedMins;
}

/** Current clock in IST (Asia/Kolkata). dow: 0=Sun … 6=Sat. */
export function nowIstParts(now = new Date()): {
  hour: number;
  minute: number;
  ymd: string;
  dow: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = get("weekday").toLowerCase();
  const dowMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    ymd,
    dow: dowMap[weekday.slice(0, 3)] ?? 0,
  };
}

/** ISO week key for weekly scheduler idempotency (IST calendar). */
export function istIsoWeekKey(now = new Date()): string {
  const { ymd } = nowIstParts(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** True on IST Saturdays at or after the configured start time. */
export function isLostInquiryScheduleDue(startTime: string, now = new Date()): boolean {
  const parsed = parseIstTimeHHmm(startTime);
  if (!parsed) return false;
  const { hour, minute, dow } = nowIstParts(now);
  if (dow !== 6) return false;
  const nowMins = hour * 60 + minute;
  const schedMins = parsed.hour * 60 + parsed.minute;
  return nowMins >= schedMins;
}

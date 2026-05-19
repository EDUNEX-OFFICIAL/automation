import { z } from "zod";

const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const dealerAutomationSettingsSchema = z
  .object({
    followUpSkipEnabled: z.boolean(),
    followUpSkipStartTime: z.string().regex(timeRe).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.followUpSkipEnabled && !data.followUpSkipStartTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Start time is required when Follow Up Skip is enabled",
        path: ["followUpSkipStartTime"],
      });
    }
  });

export type DealerAutomationSettingsPayload = z.infer<typeof dealerAutomationSettingsSchema>;

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

/** Current clock in IST (Asia/Kolkata). */
export function nowIstParts(now = new Date()): { hour: number; minute: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour: Number(get("hour")), minute: Number(get("minute")), ymd };
}

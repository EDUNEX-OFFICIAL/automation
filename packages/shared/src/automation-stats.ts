import { z } from "zod";

export const AUTOMATION_STATS_RANGES = ["all", "today", "week", "month", "custom"] as const;
export type AutomationStatsRange = (typeof AUTOMATION_STATS_RANGES)[number];

export const AUTOMATION_STATS_GROUP_BY = [
  "dealer",
  "team_leader",
  "sales_consultant",
] as const;
export type AutomationStatsGroupBy = (typeof AUTOMATION_STATS_GROUP_BY)[number];

export const automationStatsQuerySchema = z.object({
  dealerId: z.string().optional(),
  range: z.enum(AUTOMATION_STATS_RANGES).default("all"),
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(AUTOMATION_STATS_GROUP_BY).optional(),
});

export type AutomationStatsQuery = z.infer<typeof automationStatsQuerySchema>;

export type AutomationStatsKpis = {
  enquiryTransfer: number;
  followUpSkip: number;
  lostInquiry: number;
  total: number;
};

export type AutomationStatsBreakdownRow = {
  userId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  enquiryTransfer: number;
  followUpSkip: number;
  lostInquiry: number;
  total: number;
};

export type AutomationStatsDealerRow = {
  dealerId: string;
  dealerName: string;
  enquiryTransfer: number;
  followUpSkip: number;
  lostInquiry: number;
  total: number;
};

/** Daily (IST) automation volume for trend charts. */
export type AutomationStatsTimeSeriesPoint = {
  /** ISO date YYYY-MM-DD in IST */
  date: string;
  /** Short label for chart axis e.g. "7 Jun" */
  label: string;
  enquiryTransfer: number;
  followUpSkip: number;
  lostInquiry: number;
  total: number;
};

export type AutomationStatsResponse = {
  range: {
    label: string;
    from: string;
    to: string;
  };
  kpis: AutomationStatsKpis;
  timeSeries: AutomationStatsTimeSeriesPoint[];
  byTeamLeader: AutomationStatsBreakdownRow[];
  bySalesConsultant: AutomationStatsBreakdownRow[];
  byDealer?: AutomationStatsDealerRow[];
  historicalNote?: string;
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar date key YYYY-MM-DD. */
export function istDateKey(d: Date): string {
  const { y, m, day } = istParts(d);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Short chart label for an IST date key. */
export function istDateLabel(dateKey: string): string {
  const [, m, day] = dateKey.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${months[(m ?? 1) - 1]}`;
}

/** Add n IST calendar days to a date key. */
export function addIstDays(dateKey: string, n: number): string {
  const [y, m, day] = dateKey.split("-").map(Number);
  const utc = istMidnightUtc(y!, (m ?? 1) - 1, day!);
  return istDateKey(new Date(utc.getTime() + n * 24 * 60 * 60 * 1000));
}
/** Convert UTC Date to IST calendar parts. */
export function istParts(d: Date): { y: number; m: number; day: number; dow: number } {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth(),
    day: ist.getUTCDate(),
    dow: ist.getUTCDay(),
  };
}

/** IST midnight as UTC Date for calendar y-m-day in IST. */
function istMidnightUtc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day) - IST_OFFSET_MS);
}

export function startOfIstDay(d = new Date()): Date {
  const { y, m, day } = istParts(d);
  return istMidnightUtc(y, m, day);
}

export function endOfIstDay(d = new Date()): Date {
  const start = startOfIstDay(d);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** Monday-start week in IST. */
export function startOfIstWeek(d = new Date()): Date {
  const { y, m, day, dow } = istParts(d);
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const mondayDay = day - mondayOffset;
  return istMidnightUtc(y, m, mondayDay);
}

export function endOfIstWeek(d = new Date()): Date {
  const start = startOfIstWeek(d);
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
}

export function startOfIstMonth(d = new Date()): Date {
  const { y, m } = istParts(d);
  return istMidnightUtc(y, m, 1);
}

export function endOfIstMonth(d = new Date()): Date {
  const { y, m } = istParts(d);
  const nextMonth = m === 11 ? istMidnightUtc(y + 1, 0, 1) : istMidnightUtc(y, m + 1, 1);
  return new Date(nextMonth.getTime() - 1);
}

export function resolveAutomationStatsRange(input: {
  range: AutomationStatsRange;
  from?: string;
  to?: string;
}): { from: Date; to: Date; label: string } {
  const now = new Date();
  switch (input.range) {
    case "all":
      return { from: new Date(0), to: endOfIstDay(now), label: "All time" };
    case "today":
      return { from: startOfIstDay(now), to: endOfIstDay(now), label: "Today" };
    case "week":
      return { from: startOfIstWeek(now), to: endOfIstWeek(now), label: "This week" };
    case "month":
      return { from: startOfIstMonth(now), to: endOfIstMonth(now), label: "This month" };
    case "custom": {
      const from = input.from ? new Date(input.from) : startOfIstDay(now);
      const to = input.to ? new Date(input.to) : endOfIstDay(now);
      return { from, to, label: "Custom range" };
    }
    default:
      return { from: startOfIstWeek(now), to: endOfIstWeek(now), label: "This week" };
  }
}

export function rangeLabelForChip(range: AutomationStatsRange): string {
  switch (range) {
    case "all":
      return "All time";
    case "today":
      return "Today";
    case "week":
      return "This week";
    case "month":
      return "This month";
    case "custom":
      return "Custom";
    default:
      return range;
  }
}

/** GDMS dropdown / list label for an SC (matches automation-service). */
export function salesConsultantGdmsLabel(user: {
  displayName: string | null;
  username: string;
}): string {
  const name = user.displayName?.trim();
  return name || user.username;
}

/** Fuzzy match GDMS consultant display text (case-insensitive, first-two-words). */
export function gdmsLabelMatches(candidate: string, label: string): boolean {
  const a = candidate.trim().toLowerCase();
  const b = label.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const aWords = a.split(/\s+/).slice(0, 2).join(" ");
  const bWords = b.split(/\s+/).slice(0, 2).join(" ");
  if (aWords && bWords && (a.includes(bWords) || b.includes(aWords))) return true;
  return false;
}

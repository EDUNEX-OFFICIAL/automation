import { z } from "zod";

export const lostInquiryCancellationSchema = z.object({
  reasonFailure: z.string().min(1),
  lostDueTo: z.string().min(1),
  lostDueToSub: z.string().min(1),
});

export type LostInquiryCancellationPick = z.infer<typeof lostInquiryCancellationSchema>;

/** Parse remark body after leading "Lost" + separator in Follow Up History. */
export function parseLostRemarkFromHistory(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^lost\s*[,;:\-–—_\s]+\s*(.+)$/i);
  if (m?.[1]?.trim()) return m[1].trim();
  if (/^lost\b/i.test(trimmed)) return trimmed.replace(/^lost\s*/i, "").trim() || null;
  return null;
}

export function rowRemarksStartsWithLost(text: string): boolean {
  return /^\s*lost\b/i.test(text.trim());
}

/** Upcoming Sunday in IST (today if already Sunday). */
export function upcomingSundayIst(now = new Date()): { day: number; month: number; year: number } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  let y = ist.getUTCFullYear();
  let m = ist.getUTCMonth() + 1;
  let d = ist.getUTCDate();
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay();
  const addDays = dow === 0 ? 0 : 7 - dow;
  const target = new Date(Date.UTC(y, m - 1, d + addDays));
  return {
    day: target.getUTCDate(),
    month: target.getUTCMonth() + 1,
    year: target.getUTCFullYear(),
  };
}

export function formatGdmsDateDdMmYyyy(parts: { day: number; month: number; year: number }): string {
  const dd = String(parts.day).padStart(2, "0");
  const mm = String(parts.month).padStart(2, "0");
  return `${dd}/${mm}/${parts.year}`;
}

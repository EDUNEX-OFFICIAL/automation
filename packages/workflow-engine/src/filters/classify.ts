export type LeadCategory = "HOT" | "WARM" | "FAKE" | "NEED_CALL";

export type FilterContext = {
  seenPhones: Map<string, number>;
  suspiciousNamePatterns: RegExp[];
};

const DEFAULT_SUSPICIOUS: RegExp[] = [/^test/i, /^fake/i, /^asdf/i, /^\d+$/];

const PHONE_OK = /^\+?\d{8,15}$/;

function countOccurrences(phone: string, ctx: FilterContext): number {
  return ctx.seenPhones.get(phone) ?? 0;
}

export function classifyInquiry(
  row: { phone: string; name?: string; externalKey?: string },
  ctx: FilterContext,
): { category: LeadCategory; reasons: string[] } {
  const reasons: string[] = [];
  const phone = row.phone.replace(/\s+/g, "");
  if (phone.length < 8) {
    reasons.push("invalid_phone_length");
    return { category: "FAKE", reasons };
  }
  if (!PHONE_OK.test(phone)) {
    reasons.push("invalid_phone_pattern");
    return { category: "FAKE", reasons };
  }

  const dupCount = countOccurrences(phone, ctx);
  if (dupCount >= 1) {
    reasons.push("duplicate_number");
  }

  const name = row.name?.trim() ?? "";
  const patterns = [...DEFAULT_SUSPICIOUS, ...ctx.suspiciousNamePatterns];
  if (name && patterns.some((p) => p.test(name))) {
    reasons.push("suspicious_name");
  }

  if (dupCount >= 3) {
    return { category: "FAKE", reasons: [...reasons, "repeated_many"] };
  }

  if (reasons.includes("duplicate_number")) {
    return { category: "WARM", reasons };
  }
  if (reasons.includes("suspicious_name")) {
    return { category: "NEED_CALL", reasons };
  }

  if (name.length > 2) {
    return { category: "HOT", reasons };
  }
  return { category: "NEED_CALL", reasons: [...reasons, "thin_identity"] };
}

export function buildFilterContext(): FilterContext {
  return {
    seenPhones: new Map(),
    suspiciousNamePatterns: [],
  };
}

export function ingestPhone(ctx: FilterContext, phone: string): void {
  const key = phone.replace(/\s+/g, "");
  ctx.seenPhones.set(key, (ctx.seenPhones.get(key) ?? 0) + 1);
}

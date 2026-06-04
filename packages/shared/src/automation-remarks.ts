import { z } from "zod";
import {
  AUTOMATION_SOURCES,
  SUB_SOURCES_BY_PARENT,
  type SubSourceParent,
} from "./automation-options.js";

export const AUTOMATION_REMARK_SUFFIX = "...";

const remarkBaseSchema = z
  .string()
  .trim()
  .min(1, "Remark is required")
  .max(200, "Remark must be at most 200 characters");

export const enquiryRemarkRuleSchema = z
  .object({
    source: z.enum(AUTOMATION_SOURCES),
    subSource: z.string().trim().min(1).optional(),
    remarkBase: remarkBaseSchema,
  })
  .superRefine((rule, ctx) => {
    const needsSub = rule.source === "Digital" || rule.source === "CRM";
    if (needsSub && !rule.subSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Sub-source is required for ${rule.source}`,
        path: ["subSource"],
      });
      return;
    }
    if (rule.subSource && needsSub) {
      const allowed = SUB_SOURCES_BY_PARENT[rule.source as SubSourceParent];
      if (!allowed.includes(rule.subSource)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid sub-source for ${rule.source}`,
          path: ["subSource"],
        });
      }
    }
    if (!needsSub && rule.subSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Sub-source only applies to Digital or CRM",
        path: ["subSource"],
      });
    }
  });

export type EnquiryRemarkRule = z.infer<typeof enquiryRemarkRuleSchema>;

export const enquiryRemarkRulesSchema = z
  .array(enquiryRemarkRuleSchema)
  .max(50)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      const key = `${r.source}\0${r.subSource ?? ""}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate source / sub-source rule",
          path: [i],
        });
      }
      seen.add(key);
    }
  });

export const followUpSkipRemarkBasesSchema = z
  .array(remarkBaseSchema)
  .max(30)
  .superRefine((bases, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < bases.length; i++) {
      const n = normalizeRemarkBase(bases[i]!);
      if (seen.has(n.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate remark",
          path: [i],
        });
      }
      seen.add(n.toLowerCase());
    }
  });

export const defaultEnquiryRemarkBaseSchema = remarkBaseSchema;

/** Trim and strip trailing automation suffix if user pasted it. */
export function normalizeRemarkBase(input: string): string {
  let s = input.trim();
  while (s.endsWith(AUTOMATION_REMARK_SUFFIX)) {
    s = s.slice(0, -AUTOMATION_REMARK_SUFFIX.length).trimEnd();
  }
  return s;
}

export function formatAutomationRemark(base: string): string {
  const normalized = normalizeRemarkBase(base);
  return `${normalized}${AUTOMATION_REMARK_SUFFIX}`;
}

export function isAutomationRemarkFilled(value: string): boolean {
  const t = value.trim();
  return t.length >= AUTOMATION_REMARK_SUFFIX.length && t.endsWith(AUTOMATION_REMARK_SUFFIX);
}

/** Uniform random pick; empty list uses fallbackBase (default ""). */
export function pickRandomFollowUpRemark(bases: string[], fallbackBase = ""): string {
  const normalized = bases.map((b) => normalizeRemarkBase(b)).filter((b) => b.length > 0);
  if (normalized.length === 0) {
    return normalizeRemarkBase(fallbackBase);
  }
  const idx = randomInt(normalized.length);
  return normalized[idx]!;
}

function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return (buf[0]! % maxExclusive) >>> 0;
  }
  return Math.floor(Math.random() * maxExclusive);
}

/**
 * Match order: exact (source + subSource) → source-only rule → default base.
 */
export function resolveEnquiryRemarkBase(
  rules: EnquiryRemarkRule[],
  defaultBase: string,
  source: string,
  subSource?: string,
): string {
  const sub = subSource?.trim() || "";

  const exact = rules.find((r) => r.source === source && (r.subSource ?? "") === sub);
  if (exact) return normalizeRemarkBase(exact.remarkBase);

  if (sub.length > 0) {
    const sourceOnly = rules.find((r) => r.source === source && !r.subSource);
    if (sourceOnly) return normalizeRemarkBase(sourceOnly.remarkBase);
  }

  return normalizeRemarkBase(defaultBase);
}

export function normalizeEnquiryRemarkRules(raw: EnquiryRemarkRule[]): EnquiryRemarkRule[] {
  return raw.map((r) => ({
    source: r.source,
    subSource: r.subSource?.trim() || undefined,
    remarkBase: normalizeRemarkBase(r.remarkBase),
  }));
}

export function normalizeFollowUpSkipRemarkBases(raw: string[]): string[] {
  return raw.map((b) => normalizeRemarkBase(b)).filter((b) => b.length > 0);
}

export type DealerRemarkConfig = {
  defaultEnquiryRemarkBase: string;
  enquiryRemarkRules: EnquiryRemarkRule[];
  followUpSkipRemarkBases: string[];
};

export const DEFAULT_DEALER_REMARK_CONFIG: DealerRemarkConfig = {
  defaultEnquiryRemarkBase: "Call Back",
  enquiryRemarkRules: [],
  followUpSkipRemarkBases: [],
};

/** @deprecated use formatAutomationRemark — kept for tests/docs referencing old constant shape */
export const LEGACY_DEFAULT_ENQUIRY_REMARK = formatAutomationRemark("Call Back");

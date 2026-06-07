import { z } from "zod";

export const AUTOMATION_OPERATIONS = [
  "enquiry_transfer",
  "follow_up",
  "follow_up_skip",
  "lost_inquiry",
  "exchange",
  "test_drive",
] as const;

/** Operations exposed in UI and accepted by the API/worker (others disabled for now). */
export const ENABLED_AUTOMATION_OPERATIONS = [
  "enquiry_transfer",
  "follow_up_skip",
  "follow_up",
  "lost_inquiry",
] as const;

/** Manual START on Dashboard — follow_up_skip / lost_inquiry also have Settings run-now. */
export const DASHBOARD_MANUAL_OPERATIONS = ["enquiry_transfer", "follow_up", "lost_inquiry"] as const;

export type EnabledAutomationOperation = (typeof ENABLED_AUTOMATION_OPERATIONS)[number];

export type AutomationOperation = (typeof AUTOMATION_OPERATIONS)[number];

export function isEnabledAutomationOperation(
  op: string,
): op is EnabledAutomationOperation {
  return (ENABLED_AUTOMATION_OPERATIONS as readonly string[]).includes(op);
}

export const OPERATION_LABELS: Record<AutomationOperation, string> = {
  enquiry_transfer: "Enquiry transfer",
  follow_up: "Follow up",
  follow_up_skip: "Follow up skip",
  lost_inquiry: "Lost inquiry",
  exchange: "Exchange",
  test_drive: "Test drive",
};

export const AUTOMATION_SOURCES = [
  "Walkin",
  "Field Generation",
  "Digital",
  "CRM",
  "Referral",
  "Incoming Call",
  "GeM",
] as const;

export type AutomationSource = (typeof AUTOMATION_SOURCES)[number];

export const SUB_SOURCE_PARENTS = ["Digital", "CRM"] as const;

export type SubSourceParent = (typeof SUB_SOURCE_PARENTS)[number];

export const SUB_SOURCES_BY_PARENT: Record<SubSourceParent, readonly string[]> = {
  Digital: ["HMIL Social Media", "Website", "Hyper Local"],
  CRM: ["HMIL Call Centre", "Chatbot"],
};

export function sourceNeedsSubSource(source: AutomationSource): source is SubSourceParent {
  return source === "Digital" || source === "CRM";
}

/** Selected sub-sources per Digital / CRM parent (multi-select). */
export type SubSourcesSelection = Partial<Record<SubSourceParent, string[]>>;

export type AutomationRunParams = {
  operation: AutomationOperation;
  sources: AutomationSource[];
  subSources?: SubSourcesSelection;
};

const subSourceValueSchema = z.string().min(1);
const subSourceListSchema = z.array(subSourceValueSchema).min(1);

export const automationRunParamsSchema = z
  .object({
    operation: z.enum(ENABLED_AUTOMATION_OPERATIONS),
    sources: z.array(z.enum(AUTOMATION_SOURCES)),
    subSources: z
      .object({
        Digital: subSourceListSchema.optional(),
        CRM: subSourceListSchema.optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.operation === "follow_up_skip" ||
      data.operation === "follow_up" ||
      data.operation === "lost_inquiry"
    ) {
      return;
    }
    if (data.sources.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one source is required",
        path: ["sources"],
      });
      return;
    }
    for (const parent of SUB_SOURCE_PARENTS) {
      if (!data.sources.includes(parent)) continue;
      const values = data.subSources?.[parent];
      if (!values?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `At least one sub source required for ${parent}`,
          path: ["subSources", parent],
        });
        continue;
      }
      const allowed = SUB_SOURCES_BY_PARENT[parent];
      for (const value of values) {
        const normalized = value.replace(/\bHMI\b/gi, "HMIL");
        if (!allowed.includes(value) && !allowed.includes(normalized)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid sub source for ${parent}: ${value}`,
            path: ["subSources", parent],
          });
        }
      }
    }
    if (data.subSources) {
      for (const key of Object.keys(data.subSources) as SubSourceParent[]) {
        if (!data.sources.includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Sub source provided for unselected source ${key}`,
            path: ["subSources", key],
          });
        }
      }
    }
  });

export const startAutomationSchema = z
  .object({
    dealerId: z.string(),
    operation: z.enum(ENABLED_AUTOMATION_OPERATIONS),
    sources: z.array(z.enum(AUTOMATION_SOURCES)).default([]),
    subSources: z
      .object({
        Digital: subSourceListSchema.optional(),
        CRM: subSourceListSchema.optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const parsed = automationRunParamsSchema.safeParse({
      operation: data.operation,
      sources: data.sources,
      subSources: data.subSources,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue);
      }
    }
  });

export type WorkflowJobData = {
  runId: string;
  dealerId: string;
  /** User whose GDMS credentials the run uses (TL/SC). */
  startedByUserId: string;
  operation: AutomationOperation;
  sources: AutomationSource[];
  subSources?: SubSourcesSelection;
};

export function isAutomationFormValid(
  operation: AutomationOperation | "",
  sources: AutomationSource[],
  subSources: SubSourcesSelection,
): boolean {
  if (!operation) return false;
  if (operation === "follow_up_skip" || operation === "follow_up" || operation === "lost_inquiry") {
    return true;
  }
  if (sources.length === 0) return false;
  return SUB_SOURCE_PARENTS.every(
    (parent) => !sources.includes(parent) || (subSources[parent]?.length ?? 0) > 0,
  );
}

export function operationNeedsSources(operation: AutomationOperation): boolean {
  return (
    operation !== "follow_up_skip" && operation !== "follow_up" && operation !== "lost_inquiry"
  );
}

import type { LeadCategory } from "./filters/classify.js";

export type WorkflowStepType =
  | "navigate"
  | "fill"
  | "click"
  | "assert_no_gdms_login_error"
  | "wait_for_otp"
  | "wait_for_gdms_dashboard"
  | "wait_selector"
  | "extract_table"
  | "custom";

export type WorkflowStep = {
  id: string;
  type: WorkflowStepType;
  label: string;
  selector?: string;
  valueFrom?: "gdmsUsername" | "gdmsPassword" | "otp" | "static";
  staticValue?: string;
  url?: string;
  timeoutMs?: number;
  retries?: number;
};

export type WorkflowDefinition = {
  version: string;
  name: string;
  gdmsBaseUrlEnv?: boolean;
  steps: WorkflowStep[];
};

export type NormalizedInquiry = {
  externalKey?: string;
  phone: string;
  name?: string;
  status?: string;
  raw: Record<string, unknown>;
};

export type ClassifiedLead = NormalizedInquiry & {
  category: LeadCategory;
  reasons: string[];
};

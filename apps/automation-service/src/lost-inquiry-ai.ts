import { lostInquiryCancellationSchema, type LostInquiryCancellationPick } from "@gdms/shared";
import { env } from "./config.js";

export async function resolveLostInquiryCancellation(input: {
  remark: string;
  reasonFailureOptions: string[];
  lostDueToOptions: string[];
  lostDueToSubOptions: string[];
  model?: string | null;
}): Promise<LostInquiryCancellationPick | null> {
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/internal/lost-inquiry/cancellation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.AI_INTERNAL_SECRET,
      },
      body: JSON.stringify({
        remark: input.remark,
        reasonFailureOptions: input.reasonFailureOptions,
        lostDueToOptions: input.lostDueToOptions,
        lostDueToSubOptions: input.lostDueToSubOptions,
        model: input.model?.trim() || undefined,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    const parsed = lostInquiryCancellationSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type LostInquirySurveillancePlan = {
  action: "dblclick_list_row" | "click_text" | "click_confirm" | "click_tab" | "wait" | "give_up";
  targetText?: string;
  waitMs?: number;
  reason: string;
};

export async function requestLostInquirySurveillance(input: {
  step: string;
  error: string;
  remark: string | null;
  snapshot: Record<string, unknown>;
  attempt: number;
  model?: string | null;
}): Promise<LostInquirySurveillancePlan | null> {
  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/internal/lost-inquiry/surveillance`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.AI_INTERNAL_SECRET,
      },
      body: JSON.stringify({
        step: input.step,
        error: input.error,
        remark: input.remark,
        snapshot: input.snapshot,
        attempt: input.attempt,
        model: input.model?.trim() || undefined,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as LostInquirySurveillancePlan;
  } catch {
    return null;
  }
}

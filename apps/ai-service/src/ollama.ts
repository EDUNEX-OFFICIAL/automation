import type { CallStateId, OllamaIntentResult, LostInquiryCancellationPick } from "@gdms/shared";
import { env } from "./config.js";

const PROMPTS: Record<CallStateId, string> = {
  STATE_1: `Customer said (STT): """{{utterance}}"""
You are classifying the next step for a Hyundai GDMS lead call. Return ONLY compact JSON:
{"next":"ADVANCE"|"HANDOFF"|"END","summary":"one line","customerIntent":"short"}`,
  STATE_2: `Purchase timeline. Utterance: """{{utterance}}""" Return ONLY JSON {"next":"ADVANCE"|"HANDOFF"|"END","summary":"...","customerIntent":"..."}`,
  STATE_3: `Interest level. Utterance: """{{utterance}}""" Return ONLY JSON {"next":"ADVANCE"|"HANDOFF"|"END","summary":"...","customerIntent":"..."}`,
  STATE_4: `Handoff. Utterance: """{{utterance}}""" Return ONLY JSON {"next":"END","summary":"...","customerIntent":"..."}`,
};

export async function inferIntent(
  state: CallStateId,
  utterance: string,
): Promise<OllamaIntentResult> {
  const prompt = (PROMPTS[state] ?? PROMPTS.STATE_1).replace("{{utterance}}", utterance || "(silence)");

  try {
    const res = await fetch(`${env.OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const parsed = JSON.parse(data.response ?? "{}") as OllamaIntentResult;
    if (!parsed.next) throw new Error("bad ollama json");
    return parsed;
  } catch {
    return {
      next: "ADVANCE",
      summary: "Local fallback (Ollama unavailable)",
      customerIntent: "unknown",
    };
  }
}

export async function inferLostInquiryCancellation(input: {
  remark: string;
  reasonFailureOptions: string[];
  lostDueToOptions: string[];
  lostDueToSubOptions: string[];
  model?: string;
}): Promise<LostInquiryCancellationPick | null> {
  const model = input.model?.trim() || env.OLLAMA_MODEL;
  const prompt = `You pick GDMS Cancelation Info dropdown values for a lost enquiry.

Follow-up remark: """${input.remark}"""

GDMS layout:
- "Reason Failure" = first dropdown (labeled).
- "Lost due to" row has TWO dropdowns on the same line:
  - LEFT (labeled Lost due to) = parent category — pick lostDueTo from lostDueToOptions ONLY.
  - RIGHT (no label) = sub-detail — pick lostDueToSub from lostDueToSubOptions ONLY.

Examples:
- "Plan cancel ho gya" / "plan postpone" → reasonFailure often "Customer Mind Change", lostDueTo often "Plan Drop", lostDueToSub pick the closest match from sub list (e.g. "Plan Cancel"). If "Plan Cancel" is not in sub list, avoid "Credit Shortage", "Other Manufacturers" — pick the option whose words best match the remark.
- NEVER pick "Other Manufacturers" / "Credit Shortage" / "Competitor" for plan cancel remarks unless no better sub option exists.
- "Nhi kiye the inquiry" / typing mistake → reasonFailure "Human Error", sub may be "Typing Mistake".

Reason Failure options: ${JSON.stringify(input.reasonFailureOptions)}
Lost due to PARENT options (left dropdown): ${JSON.stringify(input.lostDueToOptions)}
Lost due to SUB options (right unlabeled dropdown): ${JSON.stringify(input.lostDueToSubOptions)}

Return ONLY JSON with exact strings copied from the lists above:
{"reasonFailure":"...","lostDueTo":"...","lostDueToSub":"..."}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.OLLAMA_HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { response?: string };
      const parsed = JSON.parse(data.response ?? "{}") as LostInquiryCancellationPick;
      if (!parsed.reasonFailure || !parsed.lostDueTo || !parsed.lostDueToSub) continue;

      const inList = (value: string, list: string[]) =>
        list.some((o) => o.toLowerCase() === value.toLowerCase());

      if (!inList(parsed.reasonFailure, input.reasonFailureOptions)) continue;
      if (!inList(parsed.lostDueTo, input.lostDueToOptions)) continue;
      if (
        input.lostDueToSubOptions.length > 0 &&
        !inList(parsed.lostDueToSub, input.lostDueToSubOptions)
      ) {
        continue;
      }
      if (input.lostDueToSubOptions.length === 0) {
        parsed.lostDueToSub = parsed.lostDueToSub || parsed.lostDueTo;
      }
      return parsed;
    } catch {
      /* retry */
    }
  }
  return null;
}

export type LostInquirySurveillanceAction =
  | "dblclick_list_row"
  | "click_text"
  | "click_confirm"
  | "click_tab"
  | "wait"
  | "give_up";

export async function inferLostInquirySurveillance(input: {
  step: string;
  error: string;
  remark: string | null;
  snapshot: Record<string, unknown>;
  attempt: number;
  model?: string;
}): Promise<{
  action: LostInquirySurveillanceAction;
  targetText?: string;
  waitMs?: number;
  reason: string;
} | null> {
  const model = input.model?.trim() || env.OLLAMA_MODEL;
  const prompt = `You supervise GDMS browser automation (Lost Inquiry, Follow Up Skip, Enquiry Transfer) in real time. Pick ONE recovery action.

Step that failed: ${input.step}
Error: ${input.error}
Follow-up remark goal: ${input.remark ?? "(unknown)"}
Attempt: ${input.attempt}

Live GDMS snapshot (JSON):
${JSON.stringify(input.snapshot, null, 0)}

Allowed actions:
- dblclick_list_row — enquiry list visible but SALES CUSTOMER ENQUIRY INFO modal not open; double-click the row again
- click_text — click a visible button/tab/link; set targetText to its visible label (e.g. "Confirm", "Basic Info", "Follow Up", calendar icon area)
- click_confirm — a confirm/lost/sure dialog is visible; click Confirm/Yes
- click_tab — switch enquiry modal tab; targetText e.g. "Basic Info" or "Follow Up"
- wait — wait for slow UI; set waitMs 800-2500
- give_up — only if no safe recovery

For step next_follow_up_time: ensure Follow Up tab is active and Next Follow Up Time date/time picker opens (click_tab "Follow Up" or click_text near calendar/clock on Next Follow Up Time row).

Return ONLY JSON:
{"action":"dblclick_list_row|click_text|click_confirm|click_tab|wait|give_up","targetText":"optional","waitMs":1200,"reason":"one line"}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.OLLAMA_HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { response?: string };
      const parsed = JSON.parse(data.response ?? "{}") as {
        action?: string;
        targetText?: string;
        waitMs?: number;
        reason?: string;
      };
      const allowed: LostInquirySurveillanceAction[] = [
        "dblclick_list_row",
        "click_text",
        "click_confirm",
        "click_tab",
        "wait",
        "give_up",
      ];
      if (!parsed.action || !allowed.includes(parsed.action as LostInquirySurveillanceAction)) continue;
      return {
        action: parsed.action as LostInquirySurveillanceAction,
        targetText: parsed.targetText?.trim() || undefined,
        waitMs: typeof parsed.waitMs === "number" ? parsed.waitMs : undefined,
        reason: parsed.reason?.trim() || "Ollama recovery",
      };
    } catch {
      /* retry */
    }
  }

  if (input.step === "open_enquiry_modal") {
    return { action: "dblclick_list_row", reason: "Fallback — retry row double-click" };
  }
  if (input.step === "confirm_lost_enquiry") {
    return { action: "click_confirm", reason: "Fallback — click confirm dialog" };
  }
  if (input.step === "next_follow_up_time") {
    return { action: "click_tab", targetText: "Follow Up", reason: "Fallback — activate Follow Up tab" };
  }
  return null;
}

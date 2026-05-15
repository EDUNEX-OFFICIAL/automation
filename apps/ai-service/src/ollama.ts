import type { CallStateId, OllamaIntentResult } from "@gdms/shared";
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

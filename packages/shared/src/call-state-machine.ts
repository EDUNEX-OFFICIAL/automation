export type CallStateId = "STATE_1" | "STATE_2" | "STATE_3" | "STATE_4";

export type CallStateMachineState = {
  current: CallStateId;
  history: { state: CallStateId; note?: string }[];
};

export const CALL_STATE_ORDER: CallStateId[] = [
  "STATE_1",
  "STATE_2",
  "STATE_3",
  "STATE_4",
];

export function initialCallState(): CallStateMachineState {
  return { current: "STATE_1", history: [{ state: "STATE_1" }] };
}

export function nextCallState(
  current: CallStateId,
  transition: "ADVANCE" | "HANDOFF" | "END",
): CallStateId {
  if (transition === "END" || transition === "HANDOFF") return "STATE_4";
  const idx = CALL_STATE_ORDER.indexOf(current);
  if (idx < 0) return "STATE_4";
  return CALL_STATE_ORDER[Math.min(idx + 1, CALL_STATE_ORDER.length - 1)] ?? "STATE_4";
}

export type OllamaIntentResult = {
  next: "ADVANCE" | "HANDOFF" | "END";
  summary: string;
  customerIntent?: string;
};

/** Redis pub/sub channel for automation → API fanout to Socket.IO */
export const WORKFLOW_REDIS_CHANNEL = "gdms:workflow_events";

export const SocketEvents = {
  OTP_REQUIRED: "OTP_REQUIRED",
  WORKFLOW_STARTED: "WORKFLOW_STARTED",
  STEP_COMPLETED: "STEP_COMPLETED",
  /** Automation run reached COMPLETED (e.g. GDMS login done). */
  WORKFLOW_COMPLETED: "WORKFLOW_COMPLETED",
  LEAD_CLASSIFIED: "LEAD_CLASSIFIED",
  CALL_STARTED: "CALL_STARTED",
  CALL_COMPLETED: "CALL_COMPLETED",
  WORKFLOW_FAILED: "WORKFLOW_FAILED",
  /** Save retries exhausted — run paused for manual CRM intervention. */
  WORKFLOW_PAUSED_USER: "WORKFLOW_PAUSED_USER",
  SCREENSHOT_FRAME: "SCREENSHOT_FRAME",
  LOG_LINE: "LOG_LINE",
  /** GDMS idle timeout or manual logout — browser opened login URL */
  GDMS_SESSION_REDIRECTED: "GDMS_SESSION_REDIRECTED",
  CONTROL_ACK: "CONTROL_ACK",
  ANDROID_HEARTBEAT: "ANDROID_HEARTBEAT",
  CALL_TASK: "CALL_TASK",
  /** Android gateway → dashboard: SIM / telephony phases */
  CALL_STATUS_UPDATE: "CALL_STATUS_UPDATE",
  /** Phase 5 stub: WebRTC / SDP / ICE forwarding (server relay TBD). */
  VOICE_SESSION_SIGNAL: "VOICE_SESSION_SIGNAL",
  PAIR_DEVICE: "PAIR_DEVICE",
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];

export type OtpRequiredPayload = {
  workflowRunId: string;
  hint?: string;
};

export type WorkflowStartedPayload = { workflowRunId: string; dealerId: string };

export type WorkflowCompletedPayload = { workflowRunId: string };

export type WorkflowPausedUserPayload = { workflowRunId: string; message?: string };

export type StepCompletedPayload = {
  workflowRunId: string;
  stepId: string;
  label: string;
};

export type LeadClassifiedPayload = {
  inquiryId: string;
  category: "HOT" | "WARM" | "FAKE" | "NEED_CALL";
};

export type CallTaskPayload = {
  type: "CALL_TASK";
  taskId: string;
  number: string;
  inquiryId?: string;
  aiCallId?: string;
};

export type CallPhase = "DIALING" | "RINGING" | "CONNECTED" | "ENDED" | "FAILED";

export type CallStatusUpdatePayload = {
  aiCallId: string;
  inquiryId: string;
  dealerId: string;
  phase: CallPhase;
  durationSec?: number;
  error?: string;
};

/** Phase 5 — opaque signalling envelope until WebRTC/media server lands */
export type VoiceSessionSignalPayload = {
  inquiryId?: string;
  aiCallId?: string;
  kind: "offer" | "answer" | "ice" | "hangup";
  /** SDP, ICE candidate JSON, etc. */
  payload?: string;
};

export type ScreenshotFramePayload = {
  workflowRunId: string;
  imageBase64: string;
  seq: number;
};

export type LogLinePayload = {
  workflowRunId: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
};

/** Max log lines kept per run (Redis + Live session UI); oldest dropped automatically. */
export const RUN_LOG_BUFFER_MAX_LINES = 500;

/** Redis list key — automation LPUSHes; API LRANGE for Live session replay. */
export function runLogBufferKey(runId: string): string {
  return `run:${runId}:log_buffer`;
}

export type GdmsSessionRedirectedPayload = {
  workflowRunId: string;
  reason: "timeout" | "logout";
};

export type ControlAckPayload = { workflowRunId: string; action: "pause" | "resume" | "stop"; ok: boolean };

export function roomForWorkflowRun(runId: string): string {
  return `run:${runId}`;
}

export function roomForDealer(dealerId: string): string {
  return `dealer:${dealerId}`;
}

export function roomForAndroidDevice(deviceId: string): string {
  return `device:${deviceId}`;
}

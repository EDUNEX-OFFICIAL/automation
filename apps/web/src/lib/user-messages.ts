export type UserMessageContext = "auth" | "network" | "generic";

const GENERIC =
  "Something went wrong. Please try again.";
const NETWORK =
  "We couldn't reach the server. Check your connection and try again.";
const API_NOT_RUNNING =
  "The API is not running (often port 4000 is in use by another app or a duplicate pnpm dev). Stop other dev processes, free port 4000, restart with a single pnpm dev, then submit OTP again.";
const SERVER =
  "Something went wrong on our side. Please try again in a moment.";
const INVALID_CREDENTIALS = "Email or password is incorrect.";
const OPEN_LOGIN_UNAVAILABLE =
  "Sign-in isn't available right now. Please contact your administrator.";
const GDMS_LOGIN_REJECTED =
  "GDMS did not accept your saved User ID or password. Update them in Settings for this dealer, then run login again. No OTP was sent.";

const TECHNICAL_PATTERNS = [
  /prisma/i,
  /ECONNREFUSED/i,
  /postgresql/i,
  /redis/i,
  /stack:/i,
  /at\s+\S+\.(ts|js):\d+/i,
  /\b500\b/,
  /\b401\b/,
  /\b403\b/,
  /\b404\b/,
  /internal server error/i,
  /pnpm\b/i,
  /localhost:\d+/i,
  /\/api-upstream/i,
  /\{.*"error"/,
];

function isTechnicalMessage(text: string): boolean {
  const t = text.trim();
  if (t.length > 120) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(t));
}

export function parseApiErrorBody(raw: string): { error?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === "string") return { error: parsed.error };
    return null;
  } catch {
    return null;
  }
}

function mapKnownApiError(message: string, context: UserMessageContext): string | null {
  const lower = message.toLowerCase();

  if (lower.includes("invalid credentials")) return INVALID_CREDENTIALS;
  if (lower.includes("email and password required")) {
    return context === "auth"
      ? "Please enter your email and password."
      : GENERIC;
  }
  if (lower.includes("could not create or load a user for open login")) {
    return OPEN_LOGIN_UNAVAILABLE;
  }
  if (lower.includes("registration disabled")) {
    return "Registration is not available. Please contact your administrator.";
  }
  if (lower.includes("no refresh") || lower.includes("invalid refresh")) {
    return "Your session expired. Please sign in again.";
  }
  if (lower.includes("internal server error")) return SERVER;
  if (lower.includes("executable doesn't exist") || lower.includes("playwright install")) {
    return "Browser automation is not set up on this computer yet. Ask your administrator to install it, then try again.";
  }
  if (lower.includes("gdms account not configured")) {
    return "GDMS login is not set up yet. Save your credentials in Settings, then try again.";
  }
  if (lower.includes("gdms rejected login") || lower.includes("no otp was sent")) {
    return GDMS_LOGIN_REJECTED;
  }
  if (lower.includes("api is not running") || lower.includes("port 4000")) {
    return API_NOT_RUNNING;
  }
  if (lower.includes("automation http")) {
    return "The automation service could not be reached. Make sure it is running and try again.";
  }
  if (
    lower.includes("worker did not pick up") ||
    lower.includes("@gdms/worker")
  ) {
    return "Automation is queued but the worker is not running on the server. Start @gdms/worker (and automation-service) with the same Redis as the API, then press Retry queue.";
  }
  if (lower.includes("run is not in live preview")) {
    return "This run is not showing a live preview. Start GDMS login from the Dashboard first.";
  }
  if (lower.includes("live preview is no longer active")) {
    return "The live browser preview has already ended. Start a new GDMS login run, or use Stop only while the preview is still active.";
  }
  if (lower.includes("already running for this dealer")) {
    return "Another automation is still marked active. Open Live session and press Stop on that run, then try START again.";
  }
  if (lower.includes("cleared automatically") || lower.includes("automation service stopped")) {
    return "A previous run was left open after the app restarted. Press START again — it should work now.";
  }

  return null;
}

export function toUserMessage(
  error: unknown,
  context: UserMessageContext = "generic",
): string {
  if (context === "network") return NETWORK;

  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  if (process.env.NODE_ENV === "development") {
    console.error("[user-message]", error);
  }

  const fromJson = parseApiErrorBody(raw);
  const apiError = fromJson?.error ?? raw;

  const known = mapKnownApiError(apiError, context);
  if (known) return known;

  if (
    error instanceof TypeError &&
    String((error as Error).message).toLowerCase().includes("fetch")
  ) {
    return NETWORK;
  }

  if (!isTechnicalMessage(apiError)) return apiError;

  if (context === "auth") return INVALID_CREDENTIALS;
  return GENERIC;
}

import { z, type ZodTypeAny } from "zod";

const apiEnvSchemaBase = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("30d"),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  REFRESH_EXPIRES_IN: z.string().default("365d"),
  /** HTTP-only refresh cookie `maxAge` (seconds); should cover typical REFRESH lifetime. */
  REFRESH_COOKIE_MAX_AGE_SEC: z.coerce.number().default(60 * 60 * 24 * 365),
  /**
   * Dev/local: empty-body login → first DB user. Forced off when NODE_ENV is production (even if set true).
   * Default: true only in development when env var is unset.
   */
  AUTH_DEV_OPEN_LOGIN: z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    return v === true || v === "true" || v === "1";
  }, z.boolean().optional()),
  CREDENTIALS_MASTER_KEY: z
    .string()
    .min(1)
    .describe("32-byte key base64-encoded for AES-256-GCM"),
  CORS_ORIGIN: z
    .string()
    .default(
      "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001",
    ),
  /** Phase 5: reserved for future voice/WebRTC signalling (logs + contract only today). */
  VOICE_BRIDGE_ENABLED: z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return false;
    return v === true || v === "true" || v === "1";
  }, z.boolean()),
  /** Comma-separated STUN URLs (Phase 6 — `GET /v1/integrations/webrtc`). */
  WEBRTC_STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  /** Comma-separated TURN URLs (optional); needs username + password. */
  WEBRTC_TURN_URLS: z.string().optional(),
  WEBRTC_TURN_USERNAME: z.string().optional(),
  WEBRTC_TURN_PASSWORD: z.string().optional(),
  AUTOMATION_SERVICE_URL: z.string().url().optional(),
  AI_SERVICE_URL: z.string().url().optional(),
  AUTOMATION_INTERNAL_SECRET: z.string().min(16).optional(),
  /** HMIL GDMS entry URL — used when resuming workflows from the API (same as worker/automation). */
  GDMS_BASE_URL: z.string().url().optional(),
});

export const apiEnvSchema = apiEnvSchemaBase.transform((d) => ({
  ...d,
  AUTH_DEV_OPEN_LOGIN: d.AUTH_DEV_OPEN_LOGIN ?? d.NODE_ENV === "development",
  AUTOMATION_SERVICE_URL: d.AUTOMATION_SERVICE_URL ?? "http://localhost:4101",
  AUTOMATION_INTERNAL_SECRET: d.AUTOMATION_INTERNAL_SECRET ?? "dev-internal-secret-change-me",
}));

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_SOCKET_URL: z.string().url().default("http://localhost:4000"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CREDENTIALS_MASTER_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32).optional(),
  AUTOMATION_SERVICE_URL: z.string().url().default("http://localhost:4101"),
  AI_SERVICE_URL: z.string().url().default("http://localhost:4200"),
  API_INTERNAL_URL: z.string().url().default("http://localhost:4000"),
  AUTOMATION_INTERNAL_SECRET: z.string().min(16).default("dev-internal-secret-change-me"),
  AI_INTERNAL_SECRET: z.string().min(16).default("dev-ai-secret-change-me"),
  GDMS_BASE_URL: z.string().url().optional(),
  GDMS_INQUIRY_LIST_URL: z.string().url().optional(),
  GDMS_WORKFLOW_URL: z.string().url().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const automationEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4101),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSIONS_DIR: z.string().default("./data/sessions"),
  GDMS_BASE_URL: z.string().url(),
  WORKFLOW_ENGINE_VERSION: z.string().default("1"),
  DISPLAY: z.string().optional(),
  AUTOMATION_INTERNAL_SECRET: z.string().min(16).default("dev-internal-secret-change-me"),
  /** Default true — enquiry transfer requires a visible browser; set false only for headless-only runs. */
  PLAYWRIGHT_HEADED: z
    .string()
    .default("true")
    .transform((s) => s === "true" || s === "1"),
  /** Short hover / micro-pauses between clicks (enquiry transfer humanization). */
  GDMS_MICRO_DELAY_MIN_MS: z.coerce.number().default(300),
  GDMS_MICRO_DELAY_MAX_MS: z.coerce.number().default(1500),
  /** Min delay (ms) between UI actions during enquiry transfer. */
  GDMS_ACTION_DELAY_MIN_MS: z.coerce.number().default(2000),
  GDMS_ACTION_DELAY_MAX_MS: z.coerce.number().default(6000),
  /** Random interval between Search clicks while hunting for a matching enquiry. */
  GDMS_SEARCH_INTERVAL_MIN_MS: z.coerce.number().default(20_000),
  GDMS_SEARCH_INTERVAL_MAX_MS: z.coerce.number().default(45_000),
  /** Max time to keep searching before failing the run (0 = infinite until Stop). */
  GDMS_ENQUIRY_SEARCH_TIMEOUT_MS: z.coerce.number().default(0),
  /** Retries for Save until success toast appears. */
  GDMS_SAVE_RETRY_INTERVAL_MS: z.coerce.number().default(4000),
  GDMS_SAVE_MAX_ATTEMPTS: z.coerce.number().default(10),
  /** Keep Playwright open after failure (default: same as PLAYWRIGHT_HEADED). */
  GDMS_KEEP_BROWSER_ON_FAILURE: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : s === "true" || s === "1")),
  /** JSON array of Playwright cookie objects — local .env only, never commit secrets. */
  GDMS_BOOTSTRAP_COOKIES: z.string().optional(),
  /** When true, apply GDMS_BOOTSTRAP_COOKIES even if a persistent profile already exists. */
  GDMS_FORCE_COOKIE_BOOTSTRAP: z
    .string()
    .optional()
    .transform((s) => s === "true" || s === "1"),
  /** Transparent overlay on GDMS — blocks mouse/keyboard in the automation browser (default on). */
  GDMS_BLOCK_USER_INPUT: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : s !== "false" && s !== "0")),
});

export type AutomationEnv = z.infer<typeof automationEnvSchema>;

export const aiServiceEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4200),
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/gdms?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  OLLAMA_HOST: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2"),
  WHISPER_CLI_PATH: z.string().optional(),
  XTTS_PATH: z.string().optional(),
  RVC_PATH: z.string().optional(),
  VOICE_DATA_DIR: z.string().default("./data/voice"),
  AI_INTERNAL_SECRET: z.string().min(16).default("dev-ai-secret-change-me"),
});

export type AiServiceEnv = z.infer<typeof aiServiceEnvSchema>;

export function parseEnv<S extends ZodTypeAny>(schema: S, raw: NodeJS.ProcessEnv): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  return result.data;
}

import { parseEnv, aiServiceEnvSchema } from "@gdms/shared";

export const env = parseEnv(aiServiceEnvSchema, process.env);

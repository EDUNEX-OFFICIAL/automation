import { parseEnv, automationEnvSchema } from "@gdms/shared";

export const env = parseEnv(automationEnvSchema, process.env);

import { parseEnv, apiEnvSchema } from "@gdms/shared";
export const env = parseEnv(apiEnvSchema, process.env);

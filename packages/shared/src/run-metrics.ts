import { z } from "zod";

export const runMetricsSchema = z.object({
  processed: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  errors: z.number().int().nonnegative().optional(),
});

export type RunMetrics = z.infer<typeof runMetricsSchema>;

export type RunParamsWithMetrics = {
  operation?: string;
  sources?: string[];
  subSources?: Record<string, string[]>;
  scheduled?: boolean;
  metrics?: RunMetrics;
};

export function parseRunMetrics(runParams: unknown): RunMetrics | null {
  if (!runParams || typeof runParams !== "object") return null;
  const m = (runParams as RunParamsWithMetrics).metrics;
  if (!m) return null;
  const parsed = runMetricsSchema.safeParse(m);
  return parsed.success ? parsed.data : null;
}

export function mergeRunMetrics(
  existing: RunParamsWithMetrics | null | undefined,
  patch: Partial<RunMetrics>,
): RunParamsWithMetrics {
  const base = existing ?? {};
  const prev = base.metrics ?? {};
  return {
    ...base,
    metrics: {
      processed: patch.processed ?? prev.processed ?? 0,
      skipped: patch.skipped ?? prev.skipped ?? 0,
      errors: patch.errors ?? prev.errors ?? 0,
    },
  };
}

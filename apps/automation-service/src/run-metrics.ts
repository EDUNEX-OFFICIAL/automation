import type { PrismaClient } from "@gdms/database";
import { mergeRunMetrics, type RunMetrics } from "@gdms/shared";

export async function patchRunMetrics(
  prisma: PrismaClient,
  runId: string,
  patch: Partial<RunMetrics>,
): Promise<void> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { runParams: true },
  });
  if (!run) return;
  const params = mergeRunMetrics(
    (run.runParams as Record<string, unknown> | null) ?? undefined,
    patch,
  );
  await prisma.workflowRun.update({
    where: { id: runId },
    data: { runParams: params as object },
  });
}

export async function incrementRunMetric(
  prisma: PrismaClient,
  runId: string,
  field: keyof RunMetrics,
  by = 1,
): Promise<void> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { runParams: true },
  });
  if (!run) return;
  const params = (run.runParams as Record<string, unknown> | null) ?? {};
  const metrics = (params.metrics as RunMetrics | undefined) ?? {};
  await patchRunMetrics(prisma, runId, {
    [field]: (metrics[field] ?? 0) + by,
  });
}

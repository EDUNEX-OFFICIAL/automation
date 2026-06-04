import type { Prisma } from "@gdms/database";
import { mergeRunMetrics, type RunMetrics } from "@gdms/shared";
import { prisma } from "../prisma.js";

export async function patchRunMetrics(runId: string, patch: Partial<RunMetrics>): Promise<void> {
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
    data: { runParams: params as Prisma.InputJsonValue },
  });
}

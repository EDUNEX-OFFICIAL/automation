import { prisma } from "../prisma.js";
import { getRunLogBuffer } from "../run-log-buffer.js";

export async function archiveRunLogsToDb(runId: string): Promise<number> {
  const existing = await prisma.workflowRunLog.count({ where: { runId } });
  if (existing > 0) return existing;

  const lines = await getRunLogBuffer(runId);
  if (lines.length === 0) return 0;

  await prisma.workflowRunLog.createMany({
    data: lines.map((l) => ({
      runId,
      level: l.level,
      message: l.message,
      ts: new Date(l.ts),
    })),
  });
  return lines.length;
}

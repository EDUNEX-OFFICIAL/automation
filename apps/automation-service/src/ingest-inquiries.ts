import type { PrismaClient } from "@gdms/database";
import { Redis } from "ioredis";
import type { LogLinePayload } from "@gdms/shared";
import { SocketEvents, WORKFLOW_REDIS_CHANNEL } from "@gdms/shared";
import type { Page } from "playwright";
import { buildFilterContext, classifyInquiry, ingestPhone } from "@gdms/workflow-engine";

const ROW_SEL = process.env.GDMS_SEL_INQUIRY_ROW ?? "table tbody tr";

async function publish(
  redis: Redis,
  type: string,
  dealerId: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

export async function ingestInquiriesFromPage(
  page: Page,
  dealerId: string,
  redis: Redis,
  prisma: PrismaClient,
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
): Promise<void> {
  await log("info", `Scraping inquiries with selector ${ROW_SEL}`);
  const rows = await page.$$eval(
    ROW_SEL,
    (els) =>
      els.map((el) => ({
        text: el.textContent ?? "",
        title: el.getAttribute("data-phone") ?? "",
      })),
  );

  const ctx = buildFilterContext();
  const existing = await prisma.inquiry.findMany({
    where: { dealerId },
    select: { phone: true },
  });
  for (const e of existing) ingestPhone(ctx, e.phone);

  let n = 0;
  for (const r of rows) {
    const parts = r.text.split(/\s+/).filter(Boolean);
    const phone = (r.title || parts.find((p: string) => /^\+?\d{8,15}$/.test(p.replace(/\D/g, ""))) || "")
      .replace(/\D/g, "");
    const digits = phone.length >= 8 ? phone.slice(-10) : "";
    if (!digits) continue;
    const name = parts[0] ?? "Unknown";
    const { category, reasons } = classifyInquiry(
      { phone: digits, name, externalKey: `${digits}-${n}` },
      ctx,
    );
    ingestPhone(ctx, digits);

    const inquiry = await prisma.inquiry.create({
      data: {
        dealerId,
        phone: digits,
        name,
        externalKey: `row-${n++}`,
        category,
        gdmsPayload: { raw: r.text, reasons } as object,
      },
    });

    await publish(redis, SocketEvents.LEAD_CLASSIFIED, dealerId, {
      inquiryId: inquiry.id,
      category,
    });
  }

  await log("info", `Ingested ${n} inquiries`);
}

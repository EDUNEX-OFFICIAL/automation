import type { PrismaClient } from "@gdms/database";
import { Redis } from "ioredis";
import type { LogLinePayload } from "@gdms/shared";
import { SocketEvents, WORKFLOW_REDIS_CHANNEL } from "@gdms/shared";
import type { Page } from "playwright";
import { buildFilterContext, classifyInquiry, ingestPhone } from "@gdms/workflow-engine";

const ROW_SEL = process.env.GDMS_SEL_INQUIRY_ROW ?? "table tbody tr";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-10) : digits;
}

async function publish(
  redis: Redis,
  type: string,
  dealerId: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify({ type, dealerId, payload }));
}

async function logInquiry(
  prisma: PrismaClient,
  inquiryId: string,
  type: string,
  payload?: object,
): Promise<void> {
  await prisma.inquiryLog.create({
    data: { inquiryId, type, payload: payload ?? undefined },
  });
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
  let updated = 0;
  for (const r of rows) {
    const parts = r.text.split(/\s+/).filter(Boolean);
    const phone = (r.title || parts.find((p: string) => /^\+?\d{8,15}$/.test(p.replace(/\D/g, ""))) || "")
      .replace(/\D/g, "");
    const digits = normalizePhone(phone);
    if (!digits) continue;
    const name = parts[0] ?? "Unknown";
    const { category, reasons } = classifyInquiry(
      { phone: digits, name, externalKey: `${digits}-${n}` },
      ctx,
    );
    ingestPhone(ctx, digits);

    const existingRow = await prisma.inquiry.findFirst({
      where: { dealerId, phone: digits },
    });

    let inquiryId: string;
    if (existingRow) {
      const inquiry = await prisma.inquiry.update({
        where: { id: existingRow.id },
        data: {
          name,
          category,
          gdmsPayload: { raw: r.text, reasons } as object,
        },
      });
      inquiryId = inquiry.id;
      await logInquiry(prisma, inquiry.id, "ingest_update", { category });
      updated++;
    } else {
      const inquiry = await prisma.inquiry.create({
        data: {
          dealerId,
          phone: digits,
          name,
          externalKey: `row-${n}`,
          category,
          gdmsPayload: { raw: r.text, reasons } as object,
        },
      });
      inquiryId = inquiry.id;
      await logInquiry(prisma, inquiry.id, "ingest_create", { category });
      n++;
    }

    await publish(redis, SocketEvents.LEAD_CLASSIFIED, dealerId, {
      inquiryId,
      category,
    });
  }

  await log("info", `Ingested ${n} new, updated ${updated} inquiries`);
}

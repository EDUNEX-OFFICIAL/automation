import type { Locator } from "playwright";
import type { GdmsUiRoot } from "./gdms-session-watch.js";
import {
  loadDealerSalesConsultants,
  salesConsultantGdmsLabel,
  type ConsultantRotationState,
} from "./consultant-rotation.js";

function labelMatchesGdms(candidate: string, label: string): boolean {
  const a = candidate.trim().toLowerCase();
  const b = label.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const aWords = a.split(/\s+/).slice(0, 2).join(" ");
  const bWords = b.split(/\s+/).slice(0, 2).join(" ");
  if (aWords && bWords && (a.includes(bWords) || b.includes(aWords))) return true;
  return false;
}

async function readRowCellTexts(row: Locator): Promise<string[]> {
  const cells = row.locator("td");
  const cellCount = await cells.count();
  const texts: string[] = [];
  for (let c = 0; c < cellCount; c++) {
    texts.push((await cells.nth(c).innerText().catch(() => "")).trim());
  }
  return texts;
}

async function resolveSalesConsultantColumnIndex(surface: GdmsUiRoot): Promise<number | null> {
  const envIndex = process.env.GDMS_FOLLOW_UP_SC_COLUMN_INDEX;
  if (envIndex !== undefined && envIndex !== "") {
    const parsed = Number.parseInt(envIndex, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }

  const headers = surface.locator("table thead th, table thead td");
  const count = await headers.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const text = (await headers.nth(i).innerText().catch(() => "")).trim();
    if (/sales\s*consultant|name\s*of\s*consul|sale\s*consul/i.test(text)) return i;
  }
  return null;
}

/** Normalize a GDMS SC label against known dealer SC display names. */
export function resolveKnownScLabel(
  raw: string | null | undefined,
  knownLabels: string[],
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const exact = knownLabels.find((l) => labelMatchesGdms(trimmed, l));
  return exact ?? trimmed;
}

function matchLabelFromTexts(texts: string[], knownLabels: string[]): string | null {
  for (const label of knownLabels) {
    for (const cell of texts) {
      if (labelMatchesGdms(cell, label)) return label;
    }
  }
  for (const cell of texts) {
    const trimmed = cell.trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^(walkin|digital|crm|phone|mobile|enquiry|follow)/i.test(trimmed)) continue;
    for (const label of knownLabels) {
      if (labelMatchesGdms(trimmed, label)) return label;
    }
  }
  return null;
}

/** Read Sales Consultant name from Today's Follow Up list row. */
export async function readSalesConsultantFromFollowUpRow(
  surface: GdmsUiRoot,
  row: Locator,
  knownLabels: string[],
): Promise<string | null> {
  const texts = await readRowCellTexts(row);
  if (texts.length === 0) return null;

  const colIndex = await resolveSalesConsultantColumnIndex(surface);
  if (colIndex !== null && colIndex < texts.length) {
    const fromCol = texts[colIndex]?.trim();
    if (fromCol) {
      const exact = knownLabels.find((l) => labelMatchesGdms(fromCol, l));
      return exact ?? fromCol;
    }
  }

  return matchLabelFromTexts(texts, knownLabels);
}

export async function loadFollowUpSkipScLabels(
  prisma: import("@gdms/database").PrismaClient,
  dealerId: string,
): Promise<string[]> {
  const scs = await loadDealerSalesConsultants(prisma, dealerId);
  return scs.map((u) => salesConsultantGdmsLabel(u)).filter((l) => l.length > 0);
}

export type { ConsultantRotationState };

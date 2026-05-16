import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright";
import type { LogLinePayload } from "@gdms/shared";
import { env } from "./config.js";
import { humanCarIconClick } from "./human-delay.js";

type GdmsUiRoot = Page | Frame;

const EXCLUDE_RE = /progress|irx_progress|byte/i;
const ENQUIRY_RE = /enquiry|customer|cmmd|car|sale/i;
const RAIL_PARENT_RE = /gnb|sidenav|sidebar|menu|nav_sal|nav-sale|nav_sale/i;

export type GdmsSidebarDomCandidate = {
  domIndex: number;
  tag: string;
  id: string;
  className: string;
  title: string;
  ariaLabel: string;
  href: string;
  onclick: string;
  parentTag: string;
  parentClass: string;
  siblingIndex: number;
  parentRailSiblings: number;
  inNavContainer: boolean;
  hasSvg: boolean;
  hasImg: boolean;
  textContent: string;
  x: number;
  y: number;
};

export type ScoredDomCandidate = GdmsSidebarDomCandidate & { domScore: number };

type DomFingerprint = Pick<GdmsSidebarDomCandidate, "tag" | "id" | "className" | "x" | "y">;

type SidebarDomEvaluatePayload =
  | { mode: "collect" }
  | { mode: "click"; fp: DomFingerprint };

/** Delegates to addInitScript-loaded gdms-sidebar-inpage.js (avoids tsx __name in evaluate). */
async function evaluateSidebarDom(
  ui: GdmsUiRoot,
  payload: SidebarDomEvaluatePayload,
): Promise<GdmsSidebarDomCandidate[] | boolean> {
  return ui.evaluate((arg) => {
    const g = globalThis as typeof globalThis & {
      __gdmsSidebarEval?: (a: unknown) => unknown;
    };
    if (!g.__gdmsSidebarEval) {
      throw new Error("GDMS sidebar in-page script not loaded");
    }
    return g.__gdmsSidebarEval(arg) as GdmsSidebarDomCandidate[] | boolean;
  }, payload);
}

function isDumpDomEnabled(): boolean {
  const v = process.env.GDMS_DUMP_DOM?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export async function dumpGdmsSidebarDom(ui: GdmsUiRoot): Promise<GdmsSidebarDomCandidate[]> {
  const result = await evaluateSidebarDom(ui, { mode: "collect" });
  return result as GdmsSidebarDomCandidate[];
}

export function scoreDomCandidate(c: GdmsSidebarDomCandidate): number {
  let score = 0;
  const blob = `${c.onclick} ${c.href} ${c.title} ${c.ariaLabel} ${c.textContent}`.toLowerCase();
  if (/\bnav_sal_mis\b/i.test(c.className)) score -= 50;
  if (/\bnav_sal\b/i.test(c.className) && !/\bnav_sal_mis\b/i.test(c.className)) score += 45;
  else if (/nav-sale|nav_sale/i.test(c.className)) score += 20;
  if (c.inNavContainer) score += 12;
  if (ENQUIRY_RE.test(blob)) score += 20;
  if (c.siblingIndex === 1 && c.parentRailSiblings >= 3) score += 15;
  if (RAIL_PARENT_RE.test(c.parentClass)) score += 10;
  if (EXCLUDE_RE.test(`${c.className} ${c.id} ${c.onclick}`)) score -= 50;
  return score;
}

export function rankDomCandidates(candidates: GdmsSidebarDomCandidate[]): ScoredDomCandidate[] {
  return candidates
    .map((c) => ({ ...c, domScore: scoreDomCandidate(c) }))
    .sort((a, b) => b.domScore - a.domScore || a.y - b.y);
}

export function formatDomCandidateBrief(c: GdmsSidebarDomCandidate & { domScore?: number }): string {
  const idPart = c.id ? `#${c.id}` : "";
  const cls = c.className ? `.${c.className.split(/\s+/).slice(0, 2).join(".")}` : "";
  const onclick = c.onclick ? ` onclick=${c.onclick.slice(0, 60)}` : "";
  const score = c.domScore !== undefined ? ` score=${c.domScore}` : "";
  return `${c.tag}${idPart}${cls} sib=${c.siblingIndex}/${c.parentRailSiblings}${onclick}${score}`;
}

export function domCandidateLocator(
  ui: GdmsUiRoot,
  c: GdmsSidebarDomCandidate,
): Locator | null {
  if (c.id) {
    return ui.locator(`[id="${c.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  }
  if (/\bnav_sal\b/i.test(c.className) && !/\bnav_sal_mis\b/i.test(c.className)) {
    return ui.locator("li.nav_sal, .nav_sal").first();
  }
  const token = c.className
    .split(/\s+/)
    .map((t) => t.trim())
    .find((t) => t.length > 2 && !/^(active|on|off|selected)$/i.test(t));
  if (token) {
    return ui.locator(`${c.tag}.${token.replace(/\./g, "\\.")}`).first();
  }
  return null;
}

export async function clickDomCandidate(ui: GdmsUiRoot, c: GdmsSidebarDomCandidate): Promise<void> {
  const loc = domCandidateLocator(ui, c);
  if (loc) {
    await humanCarIconClick(loc);
    return;
  }
  const fp: DomFingerprint = {
    tag: c.tag,
    id: c.id,
    className: c.className,
    x: c.x,
    y: c.y,
  };
  const ok = (await evaluateSidebarDom(ui, { mode: "click", fp })) as boolean;
  if (!ok) throw new Error(`DOM sidebar click missed ${formatDomCandidateBrief(c)}`);
}

export async function clickDomCandidateAtIndex(
  ui: GdmsUiRoot,
  domIndex: number,
): Promise<void> {
  const candidates = await dumpGdmsSidebarDom(ui);
  const c = candidates[domIndex];
  if (!c) throw new Error(`DOM sidebar click missed index ${domIndex}`);
  await clickDomCandidate(ui, c);
}

export async function logTopDomCandidates(
  candidates: GdmsSidebarDomCandidate[],
  log: (level: LogLinePayload["level"], message: string) => Promise<void>,
  limit = 5,
): Promise<void> {
  const ranked = rankDomCandidates(candidates).slice(0, limit);
  if (!ranked.length) {
    await log("info", "GDMS sidebar DOM: no left-rail candidates.");
    return;
  }
  const lines = ranked.map((c, i) => `${i + 1}. ${formatDomCandidateBrief(c)}`);
  await log("info", `GDMS sidebar DOM top candidates: ${lines.join(" | ")}`);
}

export async function writeDomDumpFile(
  candidates: GdmsSidebarDomCandidate[],
  runId: string | undefined,
  label: string,
): Promise<string | null> {
  if (!isDumpDomEnabled()) return null;
  const id = runId?.trim() || `adhoc-${Date.now()}`;
  const dir = path.join(env.SESSIONS_DIR, "dom-dumps");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}-${label}-sidebar.json`);
  const ranked = rankDomCandidates(candidates);
  await writeFile(
    file,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        label,
        runId: id,
        candidates: ranked,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

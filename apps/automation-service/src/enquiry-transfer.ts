import type { Redis } from "ioredis";
import type { Page, Locator } from "playwright";
import type { LogLinePayload } from "@gdms/shared";
import {
  formatAutomationRemark,
  isAutomationRemarkFilled,
  pickRandomFollowUpRemark,
  resolveEnquiryRemarkBase,
  type DealerRemarkConfig,
} from "@gdms/shared";
import { applyInputGuardToPage, setAutomationInputBypass } from "./automation-browser-setup.js";
import { env } from "./config.js";
import { createPrisma } from "@gdms/database";
import { pickNextSalesConsultant, type ConsultantRotationState } from "./consultant-rotation.js";
import { incrementRunMetric } from "./run-metrics.js";

const prisma = createPrisma();
import {
  humanDelay,
  humanHoverClick,
  microDelay,
  pause,
  pickRandom,
  pollDelay,
  randomBetween,
  scaleMs,
  scaledRandomBetween,
  searchIntervalDelay,
} from "./human-delay.js";
import {
  clearGdmsUiRootCache,
  clickCustomerEnquiryFlyoutMgt,
  clickCustomerEnquirySidebarIcon,
  flyoutShowsCustomerEnquiryMgt,
  isCustomerEnquiryTreeExpanded,
  isOnCustomerEnquiryList,
  isOnTodaysFollowUpList,
  isSalesFlyoutOnlyOpen,
  resolveGdmsUiRoot,
  waitForCustomerEnquiryTreeExpanded,
  waitForGdmsDashboardReady,
  type GdmsUiRoot,
} from "./gdms-session-watch.js";

export { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";

const PIN_CODES = ["800001", "800006", "800020", "800026"] as const;
/** Follow Up tab required field (GDMS shows "*Enquiry Type"). */
const ENQUIRY_TYPE_LABEL_RE = /^\*?\s*Enquiry\s*Type\s*$/i;
/** Random pause after Follow Up data complete, before #btnFollowUpSave (max 4s). */
const FOLLOW_UP_SAVE_DELAY_MAX_MS = 4_000;
const FOLLOW_UP_SAVE_DELAY_MIN_MS = 1_200;
const SUCCESS_TOAST = /successfully reflected/i;

function isPlaywrightDetachError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /frame was detached/i.test(msg) ||
    /target page, context or browser has been closed/i.test(msg) ||
    /execution context was destroyed/i.test(msg)
  );
}

/** After final save, wait for CRM to dismiss enquiry UI; if stuck, re-Save up to this many times (each followed by 10–20s wait). */
const MAX_ENQUIRY_SURFACE_STUCK_RESAVES = 3;
/** Wait window for popup/modal to close on its own (ms). */
function popupCloseWaitMs(): number {
  return scaledRandomBetween(10_000, 20_000);
}
/** GDMS marks required fields with a leading asterisk (*), e.g. "* PIN", "* Verification" — not the word "Star". */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export type EnquiryTransferContext = {
  page: Page;
  runId: string;
  dealerId: string;
  /** User who started the run — rotation uses their TL's active SCs (reportsTo). */
  startedByUserId: string;
  /** Filled on first round-robin pick for this run (TL's SC list). */
  rotation?: ConsultantRotationState;
  redis: Redis;
  sources: string[];
  subSources?: Record<string, string[]>;
  remarkConfig: Pick<DealerRemarkConfig, "defaultEnquiryRemarkBase" | "enquiryRemarkRules">;
  log: (level: LogLinePayload["level"], message: string) => Promise<void>;
  shouldStop: () => Promise<boolean>;
  waitIfPaused: () => Promise<void>;
  /** Persist PAUSED_USER + socket event; always throws ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE */
  signalManualIntervention: (message: string) => Promise<never>;
};

async function resolveEnquiryFollowUpRemark(
  page: Page,
  ctx: EnquiryTransferContext,
): Promise<string> {
  const opened = await readEnquirySourceFieldsFromModal(page).catch(() => null);
  const base = resolveEnquiryRemarkBase(
    ctx.remarkConfig.enquiryRemarkRules,
    ctx.remarkConfig.defaultEnquiryRemarkBase,
    opened?.source ?? "",
    opened?.subSource,
  );
  return formatAutomationRemark(base);
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GDMS labels use HMIL; tolerate legacy HMI typos in UI or saved run params. */
function gdmsLabelNorm(s: string): string {
  return norm(s)
    .replace(/\bhmi\b/g, "hmil")
    .replace(/\bcenter\b/g, "centre");
}

/** Bidirectional partial match (case-insensitive normalized). */
function partialMatch(a: string, b: string): boolean {
  const na = gdmsLabelNorm(a);
  const nb = gdmsLabelNorm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ca = na.replace(/\s+/g, "");
  const cb = nb.replace(/\s+/g, "");
  return ca.length > 0 && cb.length > 0 && (ca.includes(cb) || cb.includes(ca));
}

type SourceCriteria = { source: string; subSource?: string };

function buildCriteria(
  sources: string[],
  subSources?: Record<string, string[]>,
): SourceCriteria[] {
  const out: SourceCriteria[] = [];
  for (const source of sources) {
    const subs = subSources?.[source] ?? [];
    if (subs.length > 0) {
      for (const subSource of subs) {
        out.push({ source, subSource });
      }
    } else {
      out.push({ source });
    }
  }
  return out;
}

function splitSourceColumns(
  enquirySource: string,
  enquirySubSource: string,
): { source: string; subSource: string } {
  if (enquirySubSource.trim()) {
    return { source: enquirySource, subSource: enquirySubSource };
  }
  const parts = enquirySource.split(/\s*\/\s*/);
  if (parts.length >= 2) {
    return { source: parts[0]!.trim(), subSource: parts.slice(1).join("/").trim() };
  }
  return { source: enquirySource, subSource: enquirySubSource };
}

/**
 * Row matches one allowed (source, sub-source) pair from the dashboard.
 * When a sub-source was selected, both source and sub must match (not source alone).
 */
function criterionMatchesRow(
  c: SourceCriteria,
  rowSourceCol: string,
  rowSubCol: string,
): boolean {
  const srcHit = partialMatch(c.source, rowSourceCol);
  if (!c.subSource) {
    return srcHit;
  }
  const subHit = partialMatch(c.subSource, rowSubCol);
  return srcHit && subHit;
}

function rowMatchesCriteria(
  enquirySource: string,
  enquirySubSource: string,
  criteria: SourceCriteria[],
): boolean {
  const { source, subSource } = splitSourceColumns(enquirySource, enquirySubSource);
  return criteria.some((c) => criterionMatchesRow(c, source, subSource));
}

/** GDMS tree item is often `visibility:hidden` in DOM but shown in UI — use menuItem + force click. */
async function clickCustomerEnquiryTreeItem(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const ui = await resolveGdmsUiRoot(page);
  const contexts: GdmsUiRoot[] = [ui, page];
  for (const frame of page.frames()) {
    if (!frame.isDetached()) contexts.push(frame);
  }

  const treeSelectors = [
    'a.menuItem[data-title="Customer Enquiry"]',
    'a[data-viewid="VIEW-D-00411"]',
    'a[data-url*="selectSalesCustomerEnquiryMain"]',
  ];

  for (const ctx of contexts) {
    for (const sel of treeSelectors) {
      const link = ctx.locator(sel).first();
      if ((await link.count().catch(() => 0)) < 1) continue;
      await link.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
      await humanDelay(300, 700);
      try {
        await link.click({ timeout: 8_000, force: true });
      } catch {
        await link.evaluate((el) => (el as HTMLElement).click());
      }
      await log("info", `Clicked Customer Enquiry tree item (${sel}).`);
      await humanDelay(800, 1500);
      return;
    }
  }

  for (const ctx of contexts) {
    const link = ctx.getByRole("link", { name: /^Customer Enquiry$/i }).first();
    if ((await link.count().catch(() => 0)) < 1) continue;
    await link.click({ timeout: 9_000, force: true });
    await log("info", "Clicked Customer Enquiry tree link (role fallback).");
    return;
  }

  throw new Error("Customer Enquiry tree item not found in menu");
}

async function navigateToCustomerEnquiry(
  page: Page,
  log: EnquiryTransferContext["log"],
  runId: string,
): Promise<void> {
  clearGdmsUiRootCache(page);
  await log("info", "Opening Customer Enquiry from sidebar (car → Mgt flyout → tree).");
  await setAutomationInputBypass(page, true);
  try {
    const treeExpanded = await isCustomerEnquiryTreeExpanded(page);
    const flyoutVisible = await flyoutShowsCustomerEnquiryMgt(page);
    const needsFlyoutMgt =
      (await isSalesFlyoutOnlyOpen(page)) || (flyoutVisible && !treeExpanded);

    if (!flyoutVisible && !treeExpanded) {
      await log("info", "Step 1/3: click sales car icon (li.nav_sal).");
      await clickCustomerEnquirySidebarIcon(page, log, { runId });
      await humanDelay(400, 900);
    }

    if (needsFlyoutMgt) {
      await log("info", "Step 2/3: click Customer Enquiry Mgt in flyout.");
      await clickCustomerEnquiryFlyoutMgt(page, log);
    } else if (!treeExpanded) {
      await log("info", "Step 1–2/3: open flyout and Customer Enquiry Mgt.");
      await clickCustomerEnquirySidebarIcon(page, log, { runId });
      await humanDelay(400, 900);
      await clickCustomerEnquiryFlyoutMgt(page, log);
    } else {
      await log("info", "Customer Enquiry menu tree already expanded — skip flyout.");
    }

    if (!(await isCustomerEnquiryTreeExpanded(page))) {
      await waitForCustomerEnquiryTreeExpanded(page, log);
    }

    await log("info", "Step 3/3: click Customer Enquiry in menu tree.");
    await clickCustomerEnquiryTreeItem(page, log);
    await humanDelay(800, 1800);
    await waitForCustomerEnquiryListShell(page, log);
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

async function waitForCustomerEnquiryListShell(
  page: Page,
  log?: EnquiryTransferContext["log"],
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isOnCustomerEnquiryList(page)) return;
    await pollDelay(500);
  }
  const url = page.url();
  await log?.(
    "warn",
    `Sales Customer Enquiry list title not visible after 90s (url=${url}). Check Lead tab and Customer Enquiry menu.`,
  );
  throw new Error(`Sales Customer Enquiry list not ready (url=${url})`);
}

function listUiContexts(page: Page): GdmsUiRoot[] {
  const contexts: GdmsUiRoot[] = [page];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (!frame.isDetached()) contexts.push(frame);
    } catch {
      /* skip */
    }
  }
  return contexts;
}

/** List grid + #btnSearch often live in a child frame, not the scored home root. */
async function resolveListPageUi(page: Page): Promise<GdmsUiRoot> {
  for (const ui of listUiContexts(page)) {
    const btnSearch = ui.locator("#btnSearch, button.btn_search.k-button").first();
    if (await btnSearch.isVisible({ timeout: 1_500 }).catch(() => false)) return ui;
  }
  for (const ui of listUiContexts(page)) {
    if (
      await ui
        .getByText(/Sales Customer Enquiry/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false)
    ) {
      return ui;
    }
  }
  return resolveGdmsUiRoot(page);
}

async function listSearchSurface(page: Page): Promise<GdmsUiRoot> {
  return resolveListPageUi(page);
}

function formatCriteriaSummary(criteria: SourceCriteria[]): string {
  return criteria
    .map((c) => (c.subSource ? `${c.source} / ${c.subSource}` : c.source))
    .join("; ");
}

async function ensureListPageForPolling(listPage: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  await waitForCustomerEnquiryListShell(listPage, log);
  await ensureLeadTabActive(listPage, log);
  await log("info", "Back on enquiry list — resuming search polling.");
}

/** Reference image 4 — Lead sub-tab must be active before Search. */
async function ensureLeadTabActive(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const ui = await listSearchSurface(page);
  const leadTab = ui.getByText(/^Lead$/i).first();
  if (!(await leadTab.isVisible({ timeout: 3_000 }).catch(() => false))) return;

  const selected =
    (await leadTab
      .evaluate((el) => {
        const row = el.closest("li, .k-tabstrip-item, [role='tab'], a, span");
        if (!row) return false;
        const cls = row.className?.toString() ?? "";
        return (
          cls.includes("k-state-active") ||
          cls.includes("k-active") ||
          cls.includes("active") ||
          row.getAttribute("aria-selected") === "true"
        );
      })
      .catch(() => false)) ?? false;

  if (selected) return;

  await setAutomationInputBypass(page, true);
  try {
    await humanHoverClick(leadTab);
    await humanDelay(500, 1200);
    await log("info", "Activated Lead tab on Sales Customer Enquiry list.");
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

type ParseRowsResult = {
  rows: { row: Locator; source: string; subSource: string }[];
  rawBodyCount: number;
  placeholderOnly: boolean;
};

function rowLooksLikePlaceholder(texts: string[]): boolean {
  const joined = texts.join(" ").toLowerCase();
  if (!joined.trim()) return true;
  return /no\s+(data|record|enquiry)|not\s+found|empty/i.test(joined);
}

async function parseResultRowsDetailed(
  surface: GdmsUiRoot,
  cols: TableColumns,
): Promise<ParseRowsResult> {
  const bodyRows = surface.locator("table tbody tr");
  const rawBodyCount = await bodyRows.count();
  const out: ParseRowsResult["rows"] = [];
  let placeholderOnly = false;

  for (let i = 0; i < rawBodyCount; i++) {
    const row = bodyRows.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();
    if (cellCount < 2) continue;
    const texts: string[] = [];
    for (let c = 0; c < cellCount; c++) {
      texts.push((await cells.nth(c).innerText()).trim());
    }
    if (rowLooksLikePlaceholder(texts)) {
      placeholderOnly = true;
      continue;
    }
    let source = texts[cols.sourceIdx] ?? "";
    let subSource = texts[cols.subSourceIdx] ?? "";
    if (!subSource.trim() && source.includes("/")) {
      const split = splitSourceColumns(source, "");
      source = split.source;
      subSource = split.subSource;
    }
    if (!source) continue;
    out.push({ row, source, subSource });
  }

  return { rows: out, rawBodyCount, placeholderOnly };
}

type TableColumns = { sourceIdx: number; subSourceIdx: number };

async function readTableColumns(surface: GdmsUiRoot): Promise<TableColumns> {
  const headers = await surface.locator("table thead th, table thead td, .ag-header-cell").allTextContents();
  const normalized = headers.map((h) => norm(h));
  let sourceIdx = normalized.findIndex((h) => h.includes("enquiry source") && !h.includes("sub"));
  let subSourceIdx = normalized.findIndex((h) => h.includes("enquiry sub"));
  if (sourceIdx < 0) sourceIdx = normalized.findIndex((h) => h === "enquiry source");
  if (subSourceIdx < 0) subSourceIdx = normalized.findIndex((h) => h.includes("sub source"));
  if (sourceIdx < 0) sourceIdx = 5;
  if (subSourceIdx < 0) subSourceIdx = sourceIdx + 1;
  return { sourceIdx, subSourceIdx };
}

async function waitForSearchResultsSettle(
  surface: GdmsUiRoot,
  page: Page,
  prevCount: number,
): Promise<number> {
  const loader = surface.locator(
    ".k-loading-mask:visible, .k-i-loading:visible, [class*='loading']:visible, [aria-busy='true']",
  );
  await loader.first().waitFor({ state: "hidden", timeout: 9_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

  for (let i = 0; i < 12; i++) {
    const count = await surface.locator("table tbody tr").count();
    if (count !== prevCount || i >= 3) return count;
    await pollDelay(400);
  }
  return surface.locator("table tbody tr").count();
}

const PAGE_LIST_SEARCH_NAME = /^search$/i;

const PAGE_LIST_SEARCH_SELECTORS = [
  "#btnSearch",
  "button#btnSearch.btn_search",
  "button.btn_search.k-button",
] as const;

function pageListSearchButtons(ui: GdmsUiRoot): Locator {
  return ui.getByRole("button", { name: PAGE_LIST_SEARCH_NAME });
}

async function isUsableListSearchButton(btn: Locator): Promise<boolean> {
  if ((await btn.count().catch(() => 0)) < 1) return false;
  return btn.isVisible({ timeout: 2_000 }).catch(() => false);
}

/** GDMS list action bar Search (`#btnSearch`) — scan all frames; never the blue header search. */
async function resolvePageListSearchButton(page: Page): Promise<Locator | null> {
  for (const ui of listUiContexts(page)) {
    for (const sel of PAGE_LIST_SEARCH_SELECTORS) {
      const btn = ui.locator(sel).first();
      if (await isUsableListSearchButton(btn)) return btn;
    }
  }

  const ui = await resolveListPageUi(page);
  const allocate = ui.getByRole("button", { name: /allocate/i }).first();
  if (await allocate.isVisible({ timeout: 2_000 }).catch(() => false)) {
    let container: Locator = allocate;
    for (let depth = 0; depth < 6; depth++) {
      container = container.locator("..");
      const inRow = container.getByRole("button", { name: PAGE_LIST_SEARCH_NAME });
      if ((await inRow.count().catch(() => 0)) < 1) continue;
      for (let i = 0; i < (await inRow.count()); i++) {
        const candidate = inRow.nth(i);
        if (await isUsableListSearchButton(candidate)) return candidate;
      }
    }
  }

  const title = ui.getByText(/Sales Customer Enquiry/i).first();
  if (await title.isVisible({ timeout: 2_000 }).catch(() => false)) {
    let block: Locator = title;
    for (let depth = 0; depth < 8; depth++) {
      block = block.locator("..");
      const inBlock = block.getByRole("button", { name: PAGE_LIST_SEARCH_NAME });
      const allocateInBlock = block.getByRole("button", { name: /allocate/i });
      if (
        (await inBlock.count().catch(() => 0)) > 0 &&
        (await allocateInBlock.count().catch(() => 0)) > 0
      ) {
        for (let i = 0; i < (await inBlock.count()); i++) {
          const candidate = inBlock.nth(i);
          if (await isUsableListSearchButton(candidate)) return candidate;
        }
      }
    }
  }

  const toolbar = ui.locator(
    ".k-toolbar, [class*='toolbar'], [class*='btn-area'], .page-header, .title-area",
  );
  const toolbarSearch = toolbar.getByRole("button", { name: PAGE_LIST_SEARCH_NAME }).first();
  if (await isUsableListSearchButton(toolbarSearch)) return toolbarSearch;

  const allSearch = pageListSearchButtons(ui);
  const n = await allSearch.count().catch(() => 0);
  if (n === 0) return null;
  if (n === 1) {
    const only = allSearch.first();
    return (await isUsableListSearchButton(only)) ? only : null;
  }

  let allocateY: number | null = null;
  if (await allocate.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const box = await allocate.boundingBox().catch(() => null);
    allocateY = box?.y ?? null;
  }

  let best: Locator | null = null;
  let bestY = -1;
  for (let i = 0; i < n; i++) {
    const candidate = allSearch.nth(i);
    if (!(await isUsableListSearchButton(candidate))) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    if (allocateY != null && box.y <= allocateY - 4) continue;
    if (box.y > bestY) {
      bestY = box.y;
      best = candidate;
    }
  }
  if (best) return best;

  const fallback = allSearch.last();
  return (await isUsableListSearchButton(fallback)) ? fallback : null;
}

async function clickSearchOnPage(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const ui = await listSearchSurface(page);
  await log(
    "info",
    "Clicking page Search (action bar — not global header search). All sources; Enquiry Source filter unchanged.",
  );

  const prevBodyCount = await ui.locator("table tbody tr").count();
  const btn = await resolvePageListSearchButton(page);

  await setAutomationInputBypass(page, true);
  try {
    if (!btn) {
      throw new Error(
        "Page action Search (#btnSearch) not found — open Sales Customer Enquiry list (Lead tab) with Allocate / + New visible.",
      );
    }
    await btn.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
    await humanDelay(300, 800);
    await btn.click({ timeout: 9_000, force: true });
    await humanDelay(1200, 2800);
    await waitForSearchResultsSettle(ui, page, prevBodyCount);
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

/** Search without Enquiry Source filter; match any row against all user-selected criteria. */
async function findMatchingRowFromAllSources(
  listPage: Page,
  criteria: SourceCriteria[],
  log: EnquiryTransferContext["log"],
): Promise<Locator | null> {
  const ui = await listSearchSurface(listPage);
  const cols = await readTableColumns(ui);

  await ensureLeadTabActive(listPage, log);
  await clickSearchOnPage(listPage, log);

  const { rows: parsed, rawBodyCount, placeholderOnly } = await parseResultRowsDetailed(ui, cols);
  if (parsed.length === 0) {
    const hint = placeholderOnly
      ? "CRM shows no-data placeholder — will Search again after a short wait."
      : rawBodyCount === 0
        ? "Table empty — will Search again after a short wait for new enquiries."
        : "No enquiry source text in rows.";
    await log(
      "info",
      `Search returned 0 useful row(s) (${rawBodyCount} tbody tr). ${hint}`,
    );
    await searchIntervalDelay();
    return null;
  }

  await log(
    "info",
    `Search returned ${parsed.length} useful row(s) — looking for: ${formatCriteriaSummary(criteria)}.`,
  );

  for (const r of parsed) {
    if (rowMatchesCriteria(r.source, r.subSource, criteria)) {
      await log(
        "info",
        `Matched enquiry — source: ${r.source}, sub-source: ${r.subSource || "(empty)"}.`,
      );
      return r.row;
    }
  }

  const sample = parsed
    .slice(0, 5)
    .map((r) => `${r.source}${r.subSource ? ` / ${r.subSource}` : ""}`)
    .join("; ");
  await log(
    "info",
    `No row matched workflow sources/sub-sources (${formatCriteriaSummary(criteria)}). Sample rows: ${sample || "(none)"} — will Search again.`,
  );
  await searchIntervalDelay();
  return null;
}

async function readEnquirySourceFieldsFromModal(
  page: Page,
): Promise<{ source: string; subSource: string } | null> {
  try {
    const modal = await visibleEnquiryModal(page);
    if (!(await modal.isVisible({ timeout: 2_000 }).catch(() => false))) return null;
    await ensureBasicInfoTabActive(modal);
    const formRoot = await enquiryModalFormRoot(modal);
    const dt = formRoot.locator("dt").filter({ hasText: /^Enquiry\s*Source/i }).first();
    if (await dt.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const dd = dt.locator("xpath=following-sibling::dd[1]");
      const parts = await dd
        .locator(".k-input-value-text, span.k-input-value-text, .k-input-inner, span.k-input")
        .allTextContents();
      const cleaned = parts.map((p) => p.trim()).filter(Boolean);
      if (cleaned.length >= 2) {
        return { source: cleaned[0]!, subSource: cleaned.slice(1).join(" ") };
      }
      if (cleaned.length === 1) {
        return splitSourceColumns(cleaned[0]!, "");
      }
    }
    const primary = await readDropdownDisplayNearLabel(modal, /^Enquiry\s*Source/i);
    if (!primary.trim()) return null;
    return splitSourceColumns(primary, "");
  } catch {
    return null;
  }
}

export async function closeVisibleEnquiryModal(page: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const close = modal.locator(".k-window-titlebar .k-i-close, .k-window-actions .k-i-close").first();
  if (await close.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await close.click({ force: true, timeout: 5_000 });
    await humanDelay(600, 1200);
    await log("info", "Closed enquiry modal to return to list search.");
  }
}

function enquiryInfoModalIn(ui: GdmsUiRoot): Locator {
  return ui.locator("[role='dialog'], .modal, .k-window").filter({
    hasText: /SALES CUSTOMER ENQUIRY INFO/i,
  });
}

function enquiryWindowWithBasicSaveIn(ui: GdmsUiRoot): Locator {
  return ui.locator(".k-window:has(#btnBasicSave), [role='dialog']:has(#btnBasicSave)");
}

function enquiryWindowWithFollowUpSaveIn(ui: GdmsUiRoot): Locator {
  return ui.locator(".k-window:has(#btnFollowUpSave), [role='dialog']:has(#btnFollowUpSave)");
}

/** PIN search popup (ref 8–9) — same title as enquiry modal but no TD Offer on Basic Info. */
async function isPinLookupSurface(candidate: Locator): Promise<boolean> {
  const onPinId = candidate.locator("#pinCodeSearchPopup");
  if ((await onPinId.count().catch(() => 0)) > 0) {
    if (await onPinId.first().isVisible({ timeout: 300 }).catch(() => false)) return true;
  }
  const id = (await candidate.getAttribute("id").catch(() => "")) ?? "";
  if (id === "pinCodeSearchPopup") return true;

  const formRoot = await enquiryModalFormRoot(candidate);
  const hasTdOffer = await formRoot
    .getByText(/^TD\s*Offer/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  if (hasTdOffer) return false;

  const hasPinFilter = await formRoot
    .getByText(/^PIN\s*Code$/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  const hasPostOffice = await formRoot
    .getByText(/^Post\s*Office\s*Name$/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
  return hasPinFilter && hasPostOffice;
}

async function collectEnquiryModalCandidates(page: Page): Promise<Locator[]> {
  const out: Locator[] = [];
  for (const ui of listUiContexts(page)) {
    for (const factory of [
      enquiryWindowWithFollowUpSaveIn,
      enquiryWindowWithBasicSaveIn,
      enquiryInfoModalIn,
    ] as const) {
      const loc = factory(ui);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) out.push(loc.nth(i));
    }
  }
  return out;
}

/** SALES CUSTOMER ENQUIRY INFO modal — exclude PIN lookup popup; prefer surface with TD Offer. */
async function visibleEnquiryModal(page: Page): Promise<Locator> {
  const candidates = await collectEnquiryModalCandidates(page);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (!(await c.isVisible({ timeout: 800 }).catch(() => false))) continue;
    if (await isPinLookupSurface(c)) continue;
    const formRoot = await enquiryModalFormRoot(c);
    if (
      await formRoot
        .getByText(/^TD\s*Offer/i)
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false)
    ) {
      return c;
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!;
    if (!(await c.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (!(await isPinLookupSurface(c))) return c;
  }
  return enquiryInfoModalIn(page).last();
}

export async function isAnyEnquiryModalVisible(page: Page): Promise<boolean> {
  for (const ui of listUiContexts(page)) {
    if (await enquiryInfoModalIn(ui).first().isVisible({ timeout: 400 }).catch(() => false)) return true;
    if (await enquiryWindowWithBasicSaveIn(ui).first().isVisible({ timeout: 400 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

function pinDialogIn(ui: GdmsUiRoot): Locator {
  return ui
    .locator("#pinCodeSearchPopup, [role='dialog'], .modal, .k-window")
    .filter({ hasText: /PIN Code|Post Office Name/i });
}

/** Prefer #pinCodeSearchPopup (ref 8–9); fallback to dialog with PIN filter labels. */
async function visiblePinLookupPopup(page: Page): Promise<Locator> {
  for (const ui of listUiContexts(page)) {
    const byId = ui.locator("#pinCodeSearchPopup").first();
    if (await byId.isVisible({ timeout: 1_500 }).catch(() => false)) return byId;
  }
  for (const ui of listUiContexts(page)) {
    const d = pinDialogIn(ui).last();
    if (await d.isVisible({ timeout: 1_500 }).catch(() => false)) return d;
  }
  return pinDialogIn(page).last();
}

async function visiblePinDialog(page: Page): Promise<Locator> {
  return visiblePinLookupPopup(page);
}

/** Double-click row; returns the page that hosts SALES CUSTOMER ENQUIRY INFO (popup or same tab). */
export async function openEnquiryDetailPage(row: Locator): Promise<Page> {
  const listPage = row.page();
  const popupPromise = listPage.waitForEvent("popup", { timeout: 6_000 }).catch(() => null);
  await setAutomationInputBypass(listPage, true);
  try {
    await row.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
    await humanDelay(400, 900);
    await row.dblclick({ timeout: 7_000, force: true });
  } finally {
    await setAutomationInputBypass(listPage, false);
  }
  const popup = await popupPromise;
  const detailPage = popup ?? listPage;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await isAnyEnquiryModalVisible(detailPage)) {
      await humanDelay();
      return detailPage;
    }
    await pollDelay(400);
  }
  throw new Error("SALES CUSTOMER ENQUIRY INFO modal did not appear after double-clicking enquiry row");
}

async function waitForDetailPopupClosed(detailPage: Page, timeoutMs: number): Promise<boolean> {
  if (detailPage.isClosed()) return true;
  try {
    await detailPage.waitForEvent("close", { timeout: timeoutMs });
    return true;
  } catch {
    return detailPage.isClosed();
  }
}

async function waitForSamePageEnquiryModalHidden(listPage: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAnyEnquiryModalVisible(listPage))) return true;
    await pollDelay(400);
  }
  return !(await isAnyEnquiryModalVisible(listPage));
}

/** Extra Save on enquiry modal to nudge CRM to dismiss popup/modal (no toast check). */
async function clickSaveOnEnquiryModalIfPresent(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<boolean> {
  if (page.isClosed()) return false;
  if (!(await isAnyEnquiryModalVisible(page))) return false;
  try {
    await clickVisibleSaveInModal(page, log, true);
    await humanDelay(800, 2000);
    return true;
  } catch {
    await log("warn", "Re-save to close: Save button not visible on enquiry modal.");
    return false;
  }
}

/**
 * Do not programmatically close popup — wait for CRM to dismiss. If still open after 10–20s,
 * click Save again and wait (max 2–3 resave cycles). If still stuck, PAUSED_USER.
 */
async function waitUntilEnquirySurfaceClosedAfterTransfer(
  ctx: EnquiryTransferContext,
  detailPage: Page,
  listPage: Page,
): Promise<void> {
  const { log } = ctx;

  if (detailPage === listPage) {
    await log(
      "info",
      "Waiting for enquiry modal to close on same tab (CRM usually dismisses after save — no manual close).",
    );
    let closed = await waitForSamePageEnquiryModalHidden(listPage, popupCloseWaitMs());
    if (closed) {
      await log("info", "Enquiry modal closed — resuming list polling.");
      return;
    }
    for (let resave = 1; resave <= MAX_ENQUIRY_SURFACE_STUCK_RESAVES; resave++) {
      if (await ctx.shouldStop()) throw new Error("stopped");
      await ctx.waitIfPaused();
      await log(
        "warn",
        `Enquiry modal still visible after wait — clicking Save again (${resave}/${MAX_ENQUIRY_SURFACE_STUCK_RESAVES}) to prompt CRM to close.`,
      );
      await clickSaveOnEnquiryModalIfPresent(listPage, log);
      closed = await waitForSamePageEnquiryModalHidden(listPage, popupCloseWaitMs());
      if (closed) {
        await log("info", "Enquiry modal closed after re-save — resuming list polling.");
        return;
      }
    }
    await ctx.signalManualIntervention(
      "Sales Customer Enquiry modal did not close after repeated 10–20s waits and Save retries — CRM may be stuck; fix or close manually, then Retry transfer.",
    );
  }

  await log(
    "info",
    "Waiting for enquiry popup window to close automatically (no manual close; CRM dismisses after save).",
  );
  let closed = await waitForDetailPopupClosed(detailPage, popupCloseWaitMs());
  if (closed) {
    await log("info", "Enquiry popup closed — resuming list polling.");
    return;
  }
  for (let resave = 1; resave <= MAX_ENQUIRY_SURFACE_STUCK_RESAVES; resave++) {
    if (detailPage.isClosed()) {
      await log("info", "Enquiry popup closed — resuming list polling.");
      return;
    }
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();
    await log(
      "warn",
      `Popup still open after wait — clicking Save again (${resave}/${MAX_ENQUIRY_SURFACE_STUCK_RESAVES}).`,
    );
    await clickSaveOnEnquiryModalIfPresent(detailPage, log);
    closed = await waitForDetailPopupClosed(detailPage, popupCloseWaitMs());
    if (closed) {
      await log("info", "Enquiry popup closed after re-save — resuming list polling.");
      return;
    }
  }
  if (!detailPage.isClosed()) {
    await ctx.signalManualIntervention(
      "Enquiry popup did not close after waits and Save retries — CRM window stuck; manual intervention required, then Retry transfer.",
    );
  }
  await log("info", "Enquiry popup closed — resuming list polling.");
}

/** PIN field lives inside the enquiry modal iframe — not on the outer .k-window shell. */
async function mainFormPinInput(modal: Locator): Promise<Locator> {
  const formRoot = await enquiryModalFormRoot(modal);
  return formRoot.locator("input#pin").first();
}

async function mainFormPinHasValue(modal: Locator): Promise<boolean> {
  const pin = await mainFormPinInput(modal);
  if ((await pin.count().catch(() => 0)) < 1) return false;
  const value = (await pin.inputValue().catch(() => "")).trim();
  return value.length > 0;
}

async function resolvePinLookupTrigger(page: Page): Promise<Locator | null> {
  const triggerSelectors = [
    "dd:has(input#pin) button",
    "dd:has(input#pin) a",
    "dd:has(input#pin) img",
    "dd:has(input#pin) .k-i-search",
    "dd:has(input#pin) [class*='search']",
    "dd:has(input#pin) [class*='btn_search']",
    "dl:has(input#pin) button",
    ".box_form:has(input#pin) button",
    ".box_form:has(input#pin) a",
    ".box_form:has(input#pin) img",
  ];

  for (const ui of listUiContexts(page)) {
    const pinInput = ui.locator("input#pin").first();
    if (!(await pinInput.isVisible({ timeout: 2_000 }).catch(() => false))) continue;

    for (const sel of triggerSelectors) {
      const btn = ui.locator(sel).last();
      if ((await btn.count().catch(() => 0)) < 1) continue;
      if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) return btn;
    }

    const following = pinInput.locator(
      "xpath=following-sibling::button | following-sibling::a | following-sibling::span[contains(@class,'btn')] | following-sibling::*[.//img or .//button]",
    );
    if ((await following.count()) > 0 && (await following.first().isVisible().catch(() => false))) {
      return following.first();
    }

    const parentBtn = pinInput.locator("..").locator("button, a, img, .k-i-search, [class*='search']").last();
    if ((await parentBtn.count()) > 0 && (await parentBtn.isVisible().catch(() => false))) {
      return parentBtn;
    }

    const clicked = await ui
      .locator("input#pin")
      .first()
      .evaluate((el) => {
        const dd = el.closest("dd") ?? el.parentElement;
        if (!dd) return false;
        const target = dd.querySelector<HTMLElement>(
          "button, a, img, [class*='search'], .k-i-search, span[onclick]",
        );
        if (!target) return false;
        target.click();
        return true;
      })
      .catch(() => false);
    if (clicked) {
      return pinInput;
    }
  }
  return null;
}

async function waitForPinDialogVisible(page: Page, timeoutMs = 15_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = await visiblePinDialog(page);
    if (await d.isVisible({ timeout: 500 }).catch(() => false)) return d;
    await pollDelay(350);
  }
  throw new Error(
    "PIN lookup popup did not open — click magnifier beside PIN field on Basic Info tab.",
  );
}

/** Click magnifier beside disabled input#pin; wait for PIN Code popup. */
async function clickPinLookupTrigger(page: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const trigger = await resolvePinLookupTrigger(page);
  if (!trigger) {
    throw new Error("PIN lookup button not found beside input#pin on enquiry modal.");
  }
  const usedEvaluate = (await trigger.evaluate((el) => el.id === "pin").catch(() => false)) as boolean;
  if (!usedEvaluate) {
    await withModalInputBypass(modal, async () => {
      await trigger.scrollIntoViewIfNeeded({ timeout: 7_000 }).catch(() => {});
      await humanDelay(300, 700);
      await trigger.click({ timeout: 9_000, force: true });
    });
  } else {
    await log("info", "PIN lookup opened via DOM click beside #pin.");
  }
  await log("info", "Clicked PIN lookup (magnifier beside #pin).");
  await waitForPinDialogVisible(page);
  await humanDelay(400, 900);
}

async function pinDialogEditableRoot(pinDialog: Locator): Promise<Locator> {
  const iframe = pinDialog.frameLocator("iframe").first();
  if ((await pinDialog.locator("iframe").count().catch(() => 0)) > 0) {
    return iframe.locator("body");
  }
  return pinDialog;
}

/** Enquiry modal form fields (PIN, TD Offer, etc.) — often inside an iframe. */
async function enquiryModalFormRoot(modal: Locator): Promise<Locator> {
  if ((await modal.locator("iframe").count().catch(() => 0)) > 0) {
    return modal.frameLocator("iframe").first().locator("body");
  }
  return modal;
}

async function isVisibleInput(el: Locator): Promise<boolean> {
  if ((await el.count().catch(() => 0)) < 1) return false;
  const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tag !== "input" && tag !== "textarea") return false;
  return el.isVisible({ timeout: 1_500 }).catch(() => false);
}

async function collectVisibleFilterInputs(root: Locator): Promise<Locator[]> {
  const all = root.locator("input[type='text'], input:not([type='hidden']):not([disabled])");
  const n = await all.count().catch(() => 0);
  const visible: Locator[] = [];
  for (let i = 0; i < n; i++) {
    const inp = all.nth(i);
    if (await isVisibleInput(inp)) visible.push(inp);
  }
  return visible;
}

async function inputInPostOfficeNameRow(el: Locator): Promise<boolean> {
  return el
    .evaluate((input) => {
      let node: HTMLElement | null = input as HTMLElement;
      for (let d = 0; d < 12 && node; d++) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ");
        if (/post\s*office\s*name/i.test(text) && !/pin\s*code/i.test(text)) {
          const inputs = node.querySelectorAll("input");
          if (inputs.length <= 2 && Array.from(inputs).includes(input as HTMLInputElement)) {
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    })
    .catch(() => false);
}

async function resolvePostOfficeNameInputInDialog(pinDialog: Locator): Promise<Locator | null> {
  const root = await pinDialogEditableRoot(pinDialog);
  const label = root.locator("label, dt, th, td, span").filter({ hasText: /^Post\s*Office\s*Name$/i }).first();
  if (await label.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const inRow = label
      .locator("xpath=ancestor::tr[1]//input | ancestor::dl[1]//dd//input")
      .first();
    if (await isVisibleInput(inRow)) return inRow;
    const following = label.locator("xpath=following::input[1]");
    if (await isVisibleInput(following)) return following;
  }
  const visible = await collectVisibleFilterInputs(root);
  if (visible.length >= 1 && (await inputInPostOfficeNameRow(visible[0]!))) return visible[0]!;
  return visible.length >= 1 ? visible[0]! : null;
}

async function resolvePinCodeInputInDialog(
  pinDialog: Locator,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  const root = await pinDialogEditableRoot(pinDialog);

  for (const sel of ["input#pinCode", "input[name='pinCode']", "input[id*='pinCode' i]"] as const) {
    const el = root.locator(sel).first();
    if (await isVisibleInput(el)) return el;
  }

  const pinLabel = root.locator("label, dt, th, td, span").filter({ hasText: /^PIN\s*Code$/i }).first();
  if (await pinLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const row = pinLabel.locator("xpath=ancestor::tr[1] | ancestor::dl[1]");
    const inRow = row.locator("input").last();
    if (await isVisibleInput(inRow)) return inRow;
    const following = pinLabel.locator("xpath=following::input[1]");
    if (await isVisibleInput(following)) return following;
  }

  const roleBox = root.getByRole("textbox", { name: /^PIN\s*Code$/i }).first();
  if (await isVisibleInput(roleBox)) return roleBox;

  const visible = await collectVisibleFilterInputs(root);
  const notPostOffice: Locator[] = [];
  for (const inp of visible) {
    if (!(await inputInPostOfficeNameRow(inp))) notPostOffice.push(inp);
  }
  if (notPostOffice.length === 1) return notPostOffice[0]!;
  if (notPostOffice.length >= 2) return notPostOffice[notPostOffice.length - 1]!;

  if (visible.length === 2) {
    await log("info", "PIN popup: two filter inputs — using index 1 (PIN Code column).");
    return visible[1]!;
  }

  throw new Error("Editable PIN Code input not found inside PIN lookup popup.");
}

function isKnownPinCode(value: string): boolean {
  const v = value.trim();
  return (PIN_CODES as readonly string[]).includes(v) || /^\d{6}$/.test(v);
}

async function readPinCodeFilterValue(pinDialog: Locator): Promise<string> {
  const noopLog: EnquiryTransferContext["log"] = async () => {};
  try {
    const pinInput = await resolvePinCodeInputInDialog(pinDialog, noopLog);
    return (await pinInput.inputValue().catch(() => "")).trim();
  } catch {
    return "";
  }
}

async function pinCodeFilterHasValue(pinDialog: Locator): Promise<boolean> {
  const v = await readPinCodeFilterValue(pinDialog);
  return v.length >= 4 && (isKnownPinCode(v) || /^\d{6}$/.test(v));
}

async function clearMisplacedPinFromPostOfficeName(
  pinDialog: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const postOfficeInput = await resolvePostOfficeNameInputInDialog(pinDialog);
  if (!postOfficeInput) return;
  const value = (await postOfficeInput.inputValue().catch(() => "")).trim();
  if (!isKnownPinCode(value)) return;
  await postOfficeInput.fill("");
  await log("warn", `PIN popup: cleared misplaced PIN (${value}) from Post Office Name field.`);
}

function pinResultRowLooksValid(rowText: string): boolean {
  const text = rowText.trim();
  if (text.length < 4) return false;
  return /\d{6}/.test(text) || /S\.O|B\.O|Nagar|Patna|BIHAR/i.test(text);
}

/** Rows inside PIN popup iframe only — null if none visible yet. */
async function findPinResultRowsIfVisible(pinDialog: Locator): Promise<Locator | null> {
  const pinRoot = await pinDialogEditableRoot(pinDialog);
  const rows = pinRoot.locator("table tbody tr");
  const n = await rows.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const text = (await row.innerText().catch(() => "")).trim();
    if (pinResultRowLooksValid(text)) return rows;
  }
  return null;
}

/** Post office result rows inside #pinCodeSearchPopup only (not list grid behind popup). */
async function resolvePinResultRows(pinDialog: Locator): Promise<Locator> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await findPinResultRowsIfVisible(pinDialog);
    if (rows) return rows;
    await pollDelay(500);
  }
  throw new Error("PIN search returned no visible post office rows inside #pinCodeSearchPopup.");
}

async function selectPinRowAndAddSelected(
  page: Page,
  pinDialog: Locator,
  resultRows: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const rowCount = await resultRows.count();
  if (rowCount === 0) throw new Error("PIN search returned no rows");
  const pickIndex = pickRandom(Array.from({ length: rowCount }, (_, i) => i));
  const resultRow = resultRows.nth(pickIndex);
  const rowLabel = (await resultRow.innerText().catch(() => "")).trim().split(/\n/)[0] ?? "";
  await humanHoverClick(resultRow);
  await humanDelay(400, 900);
  await log(
    "info",
    `PIN popup: single-clicked post office row${rowLabel ? ` (${rowLabel.slice(0, 60)})` : ""}.`,
  );

  await clickAddSelectedInPinPopup(pinDialog, log);
  await log("info", "PIN popup: clicked Add Selected.");
  await waitForPinPopupClosedAndMainPinFilled(page, log);
  await log(
    "info",
    "Back on main SALES CUSTOMER ENQUIRY INFO (same window) — TD Offer / Reason / Sales Consultant next on Basic Info.",
  );
}

async function clickAddSelectedInPinPopup(
  pinDialog: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const pinRoot = await pinDialogEditableRoot(pinDialog);
  const candidates = [
    pinRoot.getByRole("button", { name: /add selected/i }),
    pinDialog.locator("#pinCodeSearchPopup").getByRole("button", { name: /add selected/i }),
  ];
  for (const c of candidates) {
    const btn = c.first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await log("info", "PIN popup: selected row — clicking Add Selected.");
      await humanHoverClick(btn);
      return;
    }
  }
  throw new Error("Add Selected button not found on PIN lookup popup.");
}

async function isPinLookupPopupVisible(page: Page): Promise<boolean> {
  for (const ui of listUiContexts(page)) {
    const popup = ui.locator("#pinCodeSearchPopup").first();
    if (await popup.isVisible({ timeout: 300 }).catch(() => false)) return true;
  }
  return false;
}

async function waitForPinPopupClosedAndMainPinFilled(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (!(await isPinLookupPopupVisible(page))) {
      const mainModal = await visibleEnquiryModal(page);
      if (await mainFormPinHasValue(mainModal)) {
        await log("info", "PIN lookup popup closed — main enquiry PIN field filled.");
        return;
      }
    }
    await pollDelay(400);
  }
  throw new Error(
    "PIN lookup popup did not close or main #pin was not filled after Add Selected.",
  );
}

async function typePinInFilterAndSearch(
  page: Page,
  pinDialog: Locator,
  pin: string,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const pinRoot = await pinDialogEditableRoot(pinDialog);
  await clearMisplacedPinFromPostOfficeName(pinDialog, log);

  await log("info", `PIN popup: typing ${pin} in PIN Code filter field.`);
  const pinInput = await resolvePinCodeInputInDialog(pinDialog, log);
  await pinInput.waitFor({ state: "visible", timeout: 5_000 });

  await withPageInputBypass(page, async () => {
    await pinInput.click();
    await pinInput.fill("");
    await pinInput.pressSequentially(pin, { delay: scaledRandomBetween(70, 200) });
    await humanDelay(300, 700);
    let typed = (await pinInput.inputValue().catch(() => "")).trim();
    if (typed !== pin) {
      await pinInput.fill(pin);
      await humanDelay(300, 600);
      typed = (await pinInput.inputValue().catch(() => "")).trim();
    }
    if (typed !== pin) {
      await clearMisplacedPinFromPostOfficeName(pinDialog, log);
      throw new Error(
        `PIN Code filter did not accept ${pin} (got "${typed}") — use PIN Code column, not Post Office Name.`,
      );
    }
  });

  const postOfficeInput = await resolvePostOfficeNameInputInDialog(pinDialog);
  if (postOfficeInput) {
    const poVal = (await postOfficeInput.inputValue().catch(() => "")).trim();
    if (poVal === pin) {
      await withPageInputBypass(page, async () => {
        await postOfficeInput.fill("");
      });
      throw new Error("PIN was typed into Post Office Name — retry after field targeting fix.");
    }
  }
  await log("info", `PIN popup: PIN Code filter shows ${pin}.`);

  let searchPin = pinRoot.getByRole("button", { name: /^search$/i }).first();
  if (!(await searchPin.isVisible({ timeout: 2_000 }).catch(() => false))) {
    searchPin = pinDialog.getByRole("button", { name: /^search$/i }).first();
  }
  await humanHoverClick(searchPin);
  await humanDelay(2000, 4500);
}

async function fillPinAndAdd(page: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  const pin = pickRandom(PIN_CODES);
  const pinDialog = await waitForPinDialogVisible(page);

  const existingRows = await findPinResultRowsIfVisible(pinDialog);
  const filterFilled = await pinCodeFilterHasValue(pinDialog);
  if (existingRows && filterFilled) {
    const n = await existingRows.count().catch(() => 0);
    await log(
      "info",
      `PIN popup: ${n} row(s) and PIN filter already set — skipping type and Search.`,
    );
    await selectPinRowAndAddSelected(page, pinDialog, existingRows, log);
    return;
  }

  if (!filterFilled) {
    await typePinInFilterAndSearch(page, pinDialog, pin, log);
  } else {
    await log("info", `PIN popup: filter already has PIN — clicking Search only.`);
    const pinRoot = await pinDialogEditableRoot(pinDialog);
    let searchPin = pinRoot.getByRole("button", { name: /^search$/i }).first();
    if (!(await searchPin.isVisible({ timeout: 2_000 }).catch(() => false))) {
      searchPin = pinDialog.getByRole("button", { name: /^search$/i }).first();
    }
    await humanHoverClick(searchPin);
    await humanDelay(2000, 4500);
  }

  const resultRows = await resolvePinResultRows(pinDialog);
  await selectPinRowAndAddSelected(page, pinDialog, resultRows, log);
}

async function ensurePinOnEnquiryModal(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  const modal = await visibleEnquiryModal(page);
  if (await mainFormPinHasValue(modal)) {
    await log(
      "info",
      "PIN already set on this enquiry screen — skipping PIN popup; continuing TD Offer on same modal.",
    );
    return modal;
  }
  if (await isPinLookupPopupVisible(page)) {
    await log("info", "PIN lookup popup already open — typing PIN in filter if needed, then Search.");
  } else {
    await log("info", "Opening * PIN lookup from enquiry modal (Basic Info tab).");
    await clickPinLookupTrigger(page, log);
  }
  await fillPinAndAdd(page, log);
  return await visibleEnquiryModal(page);
}

async function withPageInputBypass<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await setAutomationInputBypass(page, true);
  try {
    return await fn();
  } finally {
    await setAutomationInputBypass(page, false);
  }
}

async function withModalInputBypass<T>(modal: Locator, fn: () => Promise<T>): Promise<T> {
  return withPageInputBypass(modal.page(), fn);
}

async function kendoListPopupVisible(page: Page): Promise<boolean> {
  for (const root of listUiContexts(page)) {
    if (
      await root
        .locator(
          ".k-animation-container:visible .k-list, .k-list-container:visible, .k-popup:visible .k-list-item",
        )
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

const KENDO_DROPDOWN_TRIGGER_SELECTORS = [
  "span.k-select",
  ".k-dropdown-wrap",
  ".k-widget.k-dropdown",
  ".k-picker",
  "select",
] as const;

async function firstVisibleIn(loc: Locator, selectors: readonly string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const candidate = loc.locator(sel).first();
    if (await candidate.isVisible({ timeout: 800 }).catch(() => false)) return candidate;
  }
  return null;
}

/** True when element sits inside Follow Up History / list grids (not the editable form). */
async function isInKendoDataGrid(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el) => Boolean(el.closest(".k-grid, [data-role='grid'], table.k-selectable")))
    .catch(() => false);
}

/** Editable Follow Up fields block (excludes history grid at bottom). */
async function resolveFollowUpFieldsContainer(formRoot: Locator): Promise<Locator> {
  try {
    const remarks = await resolveFollowUpRemarksInput(formRoot);
    const box = remarks.locator(
      "xpath=ancestor::*[contains(@class,'box_form') or contains(@class,'form_st')][1]",
    );
    if (await box.isVisible({ timeout: 2_000 }).catch(() => false)) return box;
  } catch {
    /* fall through */
  }
  const history = formRoot.getByText(/^Follow Up History/i).first();
  if (await history.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const section = history.locator(
      "xpath=ancestor::*[contains(@class,'box_form') or contains(@class,'form_st')][1]",
    );
    if (await section.isVisible({ timeout: 1_000 }).catch(() => false)) return section;
  }
  return formRoot;
}

async function kendoDropdownTriggerAfterLabelCell(labelCell: Locator): Promise<Locator | null> {
  const nextCell = labelCell.locator("xpath=following-sibling::td[1] | following-sibling::dd[1]");
  const inNext = await firstVisibleIn(nextCell, KENDO_DROPDOWN_TRIGGER_SELECTORS);
  if (inNext) return inNext;
  const inSameCell = await firstVisibleIn(labelCell, KENDO_DROPDOWN_TRIGGER_SELECTORS);
  if (inSameCell) return inSameCell;
  const following = labelCell.locator(
    "xpath=following::span.k-select[1] | following::.k-dropdown-wrap[1] | following::span.k-input[1]",
  );
  if (await following.first().isVisible({ timeout: 800 }).catch(() => false)) {
    return following.first();
  }
  const row = labelCell.locator("xpath=ancestor::tr[1]");
  const pickIndex = await labelCell
    .evaluate((label) => {
      const row = label.closest("tr");
      if (!row) return -1;
      const triggers = Array.from(
        row.querySelectorAll("span.k-select, .k-dropdown-wrap, .k-widget.k-dropdown"),
      );
      if (triggers.length === 0) return -1;
      const labelRect = label.getBoundingClientRect();
      for (let i = 0; i < triggers.length; i++) {
        const r = triggers[i]!.getBoundingClientRect();
        if (r.left >= labelRect.left - 4) return i;
      }
      return triggers.length - 1;
    })
    .catch(() => -1);
  if (pickIndex >= 0) {
    const triggers = row.locator("span.k-select, .k-dropdown-wrap, .k-widget.k-dropdown");
    const picked = triggers.nth(pickIndex);
    if (await picked.isVisible({ timeout: 800 }).catch(() => false)) return picked;
  }
  return firstVisibleIn(row, KENDO_DROPDOWN_TRIGGER_SELECTORS);
}

/** Kendo DropDownList: open via span.k-select beside label (dt/dd, table row, or Enquiry Info grid). */
async function resolveKendoDropdownTriggerNearLabel(
  formRoot: Locator,
  label: RegExp,
): Promise<Locator> {
  const dts = formRoot.locator("dt").filter({ hasText: label });
  const dtCount = await dts.count().catch(() => 0);
  for (let i = 0; i < dtCount; i++) {
    const dt = dts.nth(i);
    if (!(await dt.isVisible({ timeout: 600 }).catch(() => false))) continue;
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    const inDd = await firstVisibleIn(dd, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inDd) return inDd;
    const boxForm = dt.locator("xpath=ancestor::*[contains(@class,'box_form')][1]");
    const inBox = await firstVisibleIn(boxForm, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inBox) return inBox;
  }

  const labelCells = formRoot.locator("td, th").filter({ hasText: label });
  const cellCount = await labelCells.count().catch(() => 0);
  for (let i = 0; i < cellCount; i++) {
    const labelCell = labelCells.nth(i);
    if (!(await labelCell.isVisible({ timeout: 600 }).catch(() => false))) continue;
    const row = labelCell.locator("xpath=ancestor::tr[1]");
    const inRow = await firstVisibleIn(row, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inRow) return inRow;
    const nextCell = labelCell.locator("xpath=following-sibling::td[1] | following-sibling::dd[1]");
    const inNext = await firstVisibleIn(nextCell, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inNext) return inNext;
  }

  const ths = formRoot.locator("th").filter({ hasText: label });
  const thCount = await ths.count().catch(() => 0);
  for (let i = 0; i < thCount; i++) {
    const th = ths.nth(i);
    if (!(await th.isVisible({ timeout: 600 }).catch(() => false))) continue;
    const row = th.locator("xpath=ancestor::tr[1]");
    const inRow = await firstVisibleIn(row, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inRow) return inRow;
    const td = th.locator("xpath=following-sibling::td[1]");
    const inTd = await firstVisibleIn(td, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inTd) return inTd;
  }

  const labelEls = formRoot.locator("dt, th, td, label, span").filter({ hasText: label });
  const labelCount = await labelEls.count().catch(() => 0);
  let labelEl: Locator | null = null;
  for (let i = 0; i < labelCount; i++) {
    const candidate = labelEls.nth(i);
    if (await candidate.isVisible({ timeout: 600 }).catch(() => false)) {
      labelEl = candidate;
      break;
    }
  }
  if (!labelEl) {
    labelEl = labelEls.first();
  }
  await labelEl.waitFor({ state: "visible", timeout: 5_000 });
  const section = labelEl.locator(
    "xpath=ancestor::*[contains(@class,'box_form') or self::tr or self::dl][1]",
  );
  const inSection = await firstVisibleIn(section, KENDO_DROPDOWN_TRIGGER_SELECTORS);
  if (inSection) return inSection;
  const following = labelEl.locator(
    "xpath=following::span.k-select[1] | following::.k-dropdown-wrap[1] | following::span.k-input[1]",
  );
  if (await following.first().isVisible({ timeout: 800 }).catch(() => false)) {
    return following.first();
  }

  throw new Error(`Kendo dropdown trigger not found for label ${String(label)}`);
}

function normalizeFollowUpFieldLabel(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\*/g, "").trim();
}

function isExactFollowUpTypeLabel(text: string): boolean {
  const n = normalizeFollowUpFieldLabel(text);
  return /^Follow Up Type$/i.test(n);
}

function isExactNextFollowUpTypeLabel(text: string): boolean {
  const n = normalizeFollowUpFieldLabel(text);
  return /^Next Follow Up Type$/i.test(n);
}

/** Follow Up Skip: dropdown on same row as Follow Up Time / Next Follow Up Time. */
async function resolveFollowUpSkipDropdownByTimeRow(
  formRoot: Locator,
  timeLabelRe: RegExp,
  typeMatcher: (text: string) => boolean,
): Promise<Locator | null> {
  const timeLabels = formRoot.locator("td, th, dt, label, span").filter({ hasText: timeLabelRe });
  const n = await timeLabels.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const timeLabel = timeLabels.nth(i);
    if (await isInKendoDataGrid(timeLabel)) continue;
    if (!(await timeLabel.isVisible({ timeout: 600 }).catch(() => false))) continue;

    const row = timeLabel.locator("xpath=ancestor::tr[1]");
    if ((await row.count().catch(() => 0)) < 1) continue;

    const typeCells = row.locator("td, th, label, span");
    const tc = await typeCells.count().catch(() => 0);
    for (let j = 0; j < tc; j++) {
      const cell = typeCells.nth(j);
      const cellText = normalizeFollowUpFieldLabel((await cell.innerText().catch(() => "")) ?? "");
      if (!typeMatcher(cellText)) continue;
      const trigger = await kendoDropdownTriggerAfterLabelCell(cell);
      if (trigger) return trigger;
    }

    const triggers = row.locator(
      ".k-widget.k-dropdown span.k-select, .k-dropdown span.k-select, .k-dropdown-wrap span.k-select",
    );
    const triggerCount = await triggers.count().catch(() => 0);
    if (triggerCount >= 1) {
      return triggers.nth(triggerCount - 1);
    }
  }
  return null;
}

/**
 * Follow Up Skip only — ignores history grid headers; picks dropdown beside label (not time picker).
 * Do not use for enquiry transfer (uses resolveKendoDropdownTriggerNearLabel).
 */
async function resolveFollowUpSkipKendoDropdownTriggerNearLabel(
  formRoot: Locator,
  label: RegExp,
): Promise<Locator> {
  if (label.source === FOLLOW_UP_TYPE_LABEL_RE.source) {
    const byRow = await resolveFollowUpSkipDropdownByTimeRow(
      formRoot,
      /^Follow Up Time$/i,
      isExactFollowUpTypeLabel,
    );
    if (byRow) return byRow;
  }
  if (/Next Follow Up Type/i.test(label.source)) {
    const byRow = await resolveFollowUpSkipDropdownByTimeRow(
      formRoot,
      /Next Follow Up Time/i,
      isExactNextFollowUpTypeLabel,
    );
    if (byRow) return byRow;
  }

  const dts = formRoot.locator("dt").filter({ hasText: label });
  const dtCount = await dts.count().catch(() => 0);
  for (let i = 0; i < dtCount; i++) {
    const dt = dts.nth(i);
    if (!(await dt.isVisible({ timeout: 600 }).catch(() => false))) continue;
    if (await isInKendoDataGrid(dt)) continue;
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    const inDd = await firstVisibleIn(dd, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inDd) return inDd;
    const boxForm = dt.locator("xpath=ancestor::*[contains(@class,'box_form')][1]");
    const inBox = await firstVisibleIn(boxForm, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inBox) return inBox;
  }

  const labelCells = formRoot.locator("td, th, dt, label, span");
  const cellCount = await labelCells.count().catch(() => 0);
  for (let i = 0; i < cellCount; i++) {
    const labelCell = labelCells.nth(i);
    if (!(await labelCell.isVisible({ timeout: 600 }).catch(() => false))) continue;
    if (await isInKendoDataGrid(labelCell)) continue;
    const cellText = normalizeFollowUpFieldLabel((await labelCell.innerText().catch(() => "")) ?? "");
    if (label.source === FOLLOW_UP_TYPE_LABEL_RE.source && !isExactFollowUpTypeLabel(cellText)) {
      continue;
    }
    if (/Next Follow Up Type/i.test(label.source) && !isExactNextFollowUpTypeLabel(cellText)) {
      continue;
    }
    if (
      label.source !== FOLLOW_UP_TYPE_LABEL_RE.source &&
      !/Next Follow Up Type/i.test(label.source) &&
      !label.test(cellText)
    ) {
      continue;
    }
    const trigger = await kendoDropdownTriggerAfterLabelCell(labelCell);
    if (trigger) return trigger;
  }

  const labelEls = formRoot.locator("dt, th, td, label, span").filter({ hasText: label });
  const labelCount = await labelEls.count().catch(() => 0);
  let labelEl: Locator | null = null;
  for (let i = 0; i < labelCount; i++) {
    const candidate = labelEls.nth(i);
    if (await isInKendoDataGrid(candidate)) continue;
    if (await candidate.isVisible({ timeout: 600 }).catch(() => false)) {
      labelEl = candidate;
      break;
    }
  }
  if (!labelEl) {
    for (let i = 0; i < labelCount; i++) {
      const candidate = labelEls.nth(i);
      if (!(await isInKendoDataGrid(candidate))) {
        labelEl = candidate;
        break;
      }
    }
  }
  if (!labelEl) {
    throw new Error(`Kendo dropdown trigger not found for label ${String(label)}`);
  }
  await labelEl.waitFor({ state: "visible", timeout: 5_000 });
  const fromCell = await kendoDropdownTriggerAfterLabelCell(labelEl);
  if (fromCell) return fromCell;
  const section = labelEl.locator(
    "xpath=ancestor::*[contains(@class,'box_form') or self::tr or self::dl][1]",
  );
  const inSection = await firstVisibleIn(section, KENDO_DROPDOWN_TRIGGER_SELECTORS);
  if (inSection) return inSection;

  throw new Error(`Kendo dropdown trigger not found for label ${String(label)}`);
}

async function resolveKendoDropdownDisplayNearLabel(
  formRoot: Locator,
  label: RegExp,
): Promise<Locator | null> {
  const dt = formRoot.locator("dt").filter({ hasText: label }).first();
  if (await dt.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    const display = dd.locator("span.k-input, .k-input-value, input[role='combobox']").first();
    if (await display.isVisible({ timeout: 800 }).catch(() => false)) return display;
  }
  const labelCell = formRoot.locator("td, th").filter({ hasText: label }).first();
  if (await labelCell.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const row = labelCell.locator("xpath=ancestor::tr[1]");
    const display = row.locator("span.k-input, .k-input-value, input[role='combobox']").first();
    if (await display.isVisible({ timeout: 800 }).catch(() => false)) return display;
    const nextCell = labelCell.locator("xpath=following-sibling::td[1]");
    const inNext = nextCell.locator("span.k-input, .k-input-value, input[role='combobox']").first();
    if (await inNext.isVisible({ timeout: 800 }).catch(() => false)) return inNext;
  }
  return null;
}

async function tryOpenKendoWidgetViaDom(trigger: Locator): Promise<boolean> {
  return trigger.evaluate((el) => {
    const host =
      el.closest(".k-dropdown") ??
      el.closest(".k-dropdown-wrap") ??
      el.closest("dd") ??
      el.parentElement;
    if (!host) return false;
    const jq = (window as unknown as { jQuery?: (n: Element) => { data: (k: string) => { open?: () => void } } })
      .jQuery;
    const inqryHidden = host.querySelector<HTMLInputElement>(
      'input[id*="InqryType"], input[id*="inqryType"]',
    );
    const widgetKeys = ["kendoDropDownList", "extdropdownlist", "ExtDropDownList", "extDropDownList"];
    let widget: { open?: () => void } | undefined;
    for (const key of widgetKeys) {
      widget =
        (inqryHidden ? jq?.(inqryHidden)?.data(key) : undefined) ??
        jq?.(host)?.data(key) ??
        jq?.(host.querySelector(".k-dropdown") ?? host)?.data(key);
      if (widget?.open) break;
    }
    if (widget?.open) {
      widget.open();
      return true;
    }
    const arrow = host.querySelector<HTMLElement>("span.k-select, .k-select");
    const display = host.querySelector<HTMLElement>("span.k-input, input[role='combobox']");
    (arrow ?? display ?? (el as HTMLElement))?.click();
    return false;
  }).catch(() => false);
}

async function finalizeEnquiryTypeSelection(page: Page): Promise<void> {
  for (const ui of listUiContexts(page)) {
    await ui
      .evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[id*="InqryType"], input[id*="inqryType"]',
        );
        if (!input) return;
        const jq = (window as unknown as { jQuery?: (n: Element) => { data: (k: string) => unknown } })
          .jQuery;
        const keys = ["kendoDropDownList", "extdropdownlist", "ExtDropDownList", "extDropDownList"];
        for (const key of keys) {
          const w = jq?.(input)?.data(key) as { close?: () => void; trigger?: (e: string) => void } | undefined;
          if (w?.close) w.close();
          if (w?.trigger) w.trigger("change");
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      })
      .catch(() => {});
  }
}

/** Enquiry Type shows Cold in the Follow Up form (GDMS often leaves hidden input empty). */
async function isEnquiryTypeDisplayCold(modal: Locator): Promise<boolean> {
  const display = (await readFollowUpEnquiryTypeDisplay(modal)).trim();
  return /\bcold\b/i.test(display);
}

/**
 * Enquiry Type: click dropdown → type "c" → Enter (manual GDMS path).
 */
async function selectEnquiryTypeColdViaTypeahead(
  page: Page,
  modal: Locator,
  log: EnquiryTransferContext["log"],
): Promise<boolean> {
  await scrollEnquiryInfoBottomIntoView(modal);
  const trigger = await resolveFollowUpEnquiryTypeTrigger(modal);
  await trigger.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});

  const host = trigger.locator("xpath=ancestor::*[contains(@class,'k-dropdown')][1]");
  const kInput = host.locator("span.k-input").first();
  const kSelect = host.locator("span.k-select").first();

  await log("info", 'Enquiry Type — single click dropdown, type "c", Enter.');

  let clicked = false;
  for (const target of [kInput, kSelect, host.locator(".k-dropdown-wrap").first(), trigger]) {
    if (!(await target.isVisible({ timeout: 800 }).catch(() => false))) continue;
    await target.click({ force: true, timeout: scaleMs(12_000) });
    clicked = true;
    break;
  }
  if (!clicked) await trigger.click({ force: true });

  await humanDelay(500, 900);

  const formRoot = await enquiryModalFormRoot(modal);
  const inqryInput = formRoot.locator('input[id*="InqryType"], input[id*="inqryType"]').first();
  if (await inqryInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await inqryInput.click({ force: true }).catch(() => {});
    await inqryInput.focus().catch(() => {});
  }

  await page.keyboard.press("c");
  await humanDelay(300, 500);
  await page.keyboard.press("Enter");
  await humanDelay(500, 900);
  await page.keyboard.press("Tab").catch(() => {});
  await finalizeEnquiryTypeSelection(page);
  await humanDelay(300, 600);

  if (await isEnquiryTypeDisplayCold(modal)) return true;
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (await isEnquiryTypeDisplayCold(modal)) return true;
    await pollDelay(300);
  }
  return false;
}

async function openKendoDropdownNearLabel(
  modal: Locator,
  label: RegExp,
  log?: EnquiryTransferContext["log"],
): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const trigger = await resolveKendoDropdownTriggerNearLabel(formRoot, label);
  await trigger.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
  if (log) await log("info", `Opening dropdown for ${String(label)} (Kendo arrow / display).`);

  const tryOpen = async (): Promise<boolean> => {
    if (await kendoListPopupVisible(modal.page())) return true;
    await humanHoverClick(trigger);
    await microDelay();
    await humanDelay(500, 1100);
    if (await kendoListPopupVisible(modal.page())) return true;

    await tryOpenKendoWidgetViaDom(trigger);
    await humanDelay(400, 900);
    if (await kendoListPopupVisible(modal.page())) return true;

    const display = await resolveKendoDropdownDisplayNearLabel(formRoot, label);
    if (display) {
      await humanHoverClick(display);
      await humanDelay(400, 900);
      if (await kendoListPopupVisible(modal.page())) return true;
      await tryOpenKendoWidgetViaDom(display);
      await humanDelay(400, 900);
      if (await kendoListPopupVisible(modal.page())) return true;
    }
    return false;
  };

  if (!(await tryOpen())) {
    throw new Error(`Kendo list did not open for ${String(label)} after clicking trigger and display.`);
  }
}

async function clickOptionInFormRoot(formRoot: Locator, optRe: RegExp): Promise<void> {
  const page = formRoot.page();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const itemSel =
      ".k-list-container:visible .k-list-item, .k-popup:visible .k-list-item, ul.k-list:visible li, .k-animation-container:visible .k-list-item";
    for (const root of [formRoot, ...listUiContexts(page)]) {
      const items = root.locator(itemSel).filter({ hasText: optRe });
      const n = await items.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const item = items.nth(i);
        if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const text = (await item.innerText().catch(() => "")).trim();
        if (!optRe.test(text) && !optRe.test(text.split(/\n/)[0] ?? "")) continue;
        await humanHoverClick(item);
        return;
      }
    }
    const roleOpt = page.getByRole("option", { name: optRe }).first();
    if (await roleOpt.isVisible({ timeout: 400 }).catch(() => false)) {
      await humanHoverClick(roleOpt);
      return;
    }
    await pollDelay(350);
  }
  throw new Error(`Dropdown option not found in enquiry form: ${String(optRe)}`);
}

async function selectDropdownInFormRoot(
  modal: Locator,
  label: RegExp,
  option: RegExp | string,
  log?: EnquiryTransferContext["log"],
): Promise<void> {
  const optRe =
    typeof option === "string" ? new RegExp(`^${escapeRegExp(option)}$`, "i") : option;
  await withModalInputBypass(modal, async () => {
    await openKendoDropdownNearLabel(modal, label, log);
    const formRoot = await enquiryModalFormRoot(modal);
    await clickOptionInFormRoot(formRoot, optRe);
    await humanDelay();
  });
}

async function selectDropdownNearLabel(
  modal: Locator,
  label: RegExp,
  option: RegExp | string,
): Promise<void> {
  await selectDropdownInFormRoot(modal, label, option);
}

async function readDropdownDisplayNearLabel(modal: Locator, label: RegExp): Promise<string> {
  const formRoot = await enquiryModalFormRoot(modal);
  const dt = formRoot.locator("dt").filter({ hasText: label }).first();
  if (await dt.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    const display = dd.locator("span.k-input, .k-input-value, input").first();
    const text = (await display.innerText().catch(() => "")).trim();
    if (text) return text;
    return (await display.inputValue().catch(() => "")).trim();
  }
  const labelCell = formRoot.locator("td, th").filter({ hasText: label }).first();
  if (await labelCell.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const row = labelCell.locator("xpath=ancestor::tr[1]");
    const display = row.locator("span.k-input, .k-input-value, input").first();
    const text = (await display.innerText().catch(() => "")).trim();
    if (text) return text;
    return (await display.inputValue().catch(() => "")).trim();
  }
  const labelEl = formRoot.locator("dt, th, td").filter({ hasText: label }).first();
  const container = labelEl.locator("xpath=ancestor::*[contains(@class,'box_form') or self::tr][1]");
  const valueEl = container.locator("span.k-input, .k-input-value, input").first();
  if ((await valueEl.count()) < 1) return "";
  const text = (await valueEl.innerText().catch(() => "")).trim();
  if (text) return text;
  return (await valueEl.inputValue().catch(() => "")).trim();
}

async function scrollEnquiryInfoBottomIntoView(modal: Locator): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const block = formRoot
    .locator("motion.div, div.box_form.form_st04, div[class*='form_st04']")
    .last();
  if (await block.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await block.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
    await humanDelay(400, 800);
  }
}

/** Scroll a labelled Kendo dropdown (TD Offer, Reason for No, Sales Consultant) into view before click. */
/** Scroll the Enquiry Info block (TD Offer lives here) into view after PIN Add Selected. */
async function scrollToEnquiryInfoSection(modal: Locator): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const section = formRoot
    .locator("motion.div, div.box_form, h3, h4, legend, span, td, th")
    .filter({ hasText: /^Enquiry\s*Info\.?$/i })
    .first();
  if (await section.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await section.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await humanDelay(400, 800);
  }
  const tdLabel = formRoot.getByText(/^TD\s*Offer/i).first();
  if (await tdLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tdLabel.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
    await humanDelay(300, 700);
  }
}

async function scrollKendoFieldIntoView(modal: Locator, label: RegExp): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  try {
    const trigger = await resolveKendoDropdownTriggerNearLabel(formRoot, label);
    await trigger.scrollIntoViewIfNeeded({ timeout: 7_000 }).catch(() => {});
  } catch {
    const labelEl = formRoot.locator("dt, th, td, label").filter({ hasText: label }).first();
    await labelEl.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
  }
  await humanDelay(300, 700);
}

async function isEnquiryBasicInfoReadyAfterPin(modal: Locator): Promise<boolean> {
  if (await isPinLookupSurface(modal)) return false;
  if (!(await mainFormPinHasValue(modal))) return false;
  const formRoot = await enquiryModalFormRoot(modal);
  if (
    await formRoot
      .locator("dt, th, td, label")
      .filter({ hasText: /TD\s*Offer/i })
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false)
  ) {
    return true;
  }
  try {
    await resolveKendoDropdownTriggerNearLabel(formRoot, /TD\s*Offer/i);
    return true;
  } catch {
    return false;
  }
}

async function prepareEnquiryBasicInfoSurface(
  modal: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  await ensureBasicInfoTabActive(modal);
  await scrollToEnquiryInfoSection(modal);
  await scrollEnquiryInfoBottomIntoView(modal);
  await humanDelay(600, 1200);
  await log("info", "Enquiry Info section ready — opening TD Offer dropdown on same modal.");
}

/**
 * After PIN Add Selected the main enquiry modal is already open — stay on it (no list navigation).
 */
async function resolveMainEnquiryBasicInfoModal(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  if (await isPinLookupPopupVisible(page)) {
    return waitForEnquiryBasicInfoAfterPin(page, log);
  }
  let modal: Locator;
  try {
    modal = await visibleEnquiryModal(page);
  } catch {
    return waitForEnquiryBasicInfoAfterPin(page, log);
  }
  if (await isEnquiryBasicInfoReadyAfterPin(modal)) {
    await log(
      "info",
      "Main enquiry modal after PIN (PIN filled, not on PIN popup) — continuing TD Offer on same screen.",
    );
    await prepareEnquiryBasicInfoSurface(modal, log);
    return modal;
  }
  return waitForEnquiryBasicInfoAfterPin(page, log);
}

async function waitForEnquiryBasicInfoAfterPin(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  await log("info", "Waiting for enquiry Basic Info after PIN (not PIN search popup).");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isPinLookupPopupVisible(page)) {
      await pollDelay(400);
      continue;
    }
    let modal: Locator;
    try {
      modal = await visibleEnquiryModal(page);
    } catch {
      await pollDelay(400);
      continue;
    }
    if (!(await modal.isVisible({ timeout: 500 }).catch(() => false))) {
      await pollDelay(400);
      continue;
    }
    if (await isPinLookupSurface(modal)) {
      await pollDelay(400);
      continue;
    }
    if (await isEnquiryBasicInfoReadyAfterPin(modal)) {
      await humanDelay(800, 1500);
      await log("info", "Enquiry Basic Info ready after PIN — main form open (ref 10).");
      await prepareEnquiryBasicInfoSurface(modal, log);
      return modal;
    }
    await pollDelay(400);
  }
  throw new Error(
    "Enquiry Basic Info did not appear after PIN — enquiry modal closed, PIN empty, or still on PIN search popup.",
  );
}

async function ensureBasicInfoTabActive(modal: Locator): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const tab = formRoot.getByText(/^Basic\s*Info/i).first();
  if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await humanHoverClick(tab);
    await humanDelay(400, 900);
  }
}

async function selectMandatoryVerificationY(modal: Locator): Promise<void> {
  const patterns: RegExp[] = [/\*\s*Verification\b/i, /\*Verification\b/i, /^Verification\b$/i];
  let lastErr: unknown;
  for (const re of patterns) {
    try {
      await selectDropdownNearLabel(modal, re, /^Y$/i);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`Could not select mandatory Verification (expected "* Verification").`);
}

async function resolveFollowUpEnquiryTypeTrigger(modal: Locator): Promise<Locator> {
  const formRoot = await enquiryModalFormRoot(modal);
  await scrollEnquiryInfoBottomIntoView(modal);
  const labels = formRoot.locator("dt, th, td, label").filter({ hasText: ENQUIRY_TYPE_LABEL_RE });
  const n = await labels.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const labelEl = labels.nth(i);
    if (!(await labelEl.isVisible({ timeout: 800 }).catch(() => false))) continue;
    const raw = (await labelEl.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!ENQUIRY_TYPE_LABEL_RE.test(raw)) continue;

    const tag = ((await labelEl.evaluate((el) => el.tagName).catch(() => "")) ?? "").toLowerCase();
    if (tag === "dt") {
      const dd = labelEl.locator("xpath=following-sibling::dd[1]");
      const inDd = await firstVisibleIn(dd, KENDO_DROPDOWN_TRIGGER_SELECTORS);
      if (inDd) return inDd;
    }

    const row = labelEl.locator("xpath=ancestor::tr[1]");
    if ((await row.count().catch(() => 0)) > 0) {
      const inRow = await firstVisibleIn(row, KENDO_DROPDOWN_TRIGGER_SELECTORS);
      if (inRow) return inRow;
      const nextCell = labelEl.locator("xpath=following-sibling::td[1]");
      const inNext = await firstVisibleIn(nextCell, KENDO_DROPDOWN_TRIGGER_SELECTORS);
      if (inNext) return inNext;
    }

    const section = labelEl.locator(
      "xpath=ancestor::*[contains(@class,'box_form') or self::tr or self::dl][1]",
    );
    const inSection = await firstVisibleIn(section, KENDO_DROPDOWN_TRIGGER_SELECTORS);
    if (inSection) return inSection;

    const following = labelEl.locator(
      "xpath=following::span.k-select[1] | following::.k-dropdown-wrap[1] | following::span.k-input[1]",
    );
    if (await following.first().isVisible({ timeout: 800 }).catch(() => false)) {
      return following.first();
    }
  }
  return resolveKendoDropdownTriggerNearLabel(formRoot, ENQUIRY_TYPE_LABEL_RE);
}

async function readFollowUpEnquiryTypeDisplay(modal: Locator): Promise<string> {
  try {
    const trigger = await resolveFollowUpEnquiryTypeTrigger(modal);
    const host = trigger.locator("xpath=ancestor::tr[1] | ancestor::dd[1]");
    const display = host.locator("span.k-input, .k-input-value, input[role='combobox'], input").first();
    if (await display.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const text = (await display.innerText().catch(() => "")).trim();
      if (text) return text;
      return (await display.inputValue().catch(() => "")).trim();
    }
  } catch {
    /* fall through */
  }
  return readDropdownDisplayNearLabel(modal, ENQUIRY_TYPE_LABEL_RE);
}

/** Enquiry Type = Cold: dropdown → type "c" → Enter (once per enquiry). */
async function selectEnquiryTypeColdOnce(
  modal: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const page = modal.page();
  await scrollEnquiryInfoBottomIntoView(modal);

  if (await isEnquiryTypeDisplayCold(modal)) {
    await log("info", "Enquiry Type already Cold — skipping.");
    return;
  }

  await withModalInputBypass(modal, async () => {
    await dismissTransientKendoPopups(page);
    await humanDelay(200, 400);
    if (!(await selectEnquiryTypeColdViaTypeahead(page, modal, log))) {
      throw new Error('Enquiry Type — click dropdown, type "c", Enter did not show Cold.');
    }
    await dismissTransientKendoPopups(page);
    await closeDateTimePickerWithoutClosingModal(modal);
    await humanDelay(200, 400);
  });

  const display = (await readFollowUpEnquiryTypeDisplay(modal)).trim();
  if (!/\bcold\b/i.test(display)) {
    throw new Error(`Enquiry Type not Cold after type "c" (display="${display || "(empty)"}").`);
  }
  await log("info", `Enquiry Type = Cold (display="${display}").`);
}

const FOLLOW_UP_TYPE_LABEL_RE = /^Follow Up Type$/i;

async function isFollowUpTabReadyExceptEnquiryType(modal: Locator): Promise<boolean> {
  const formRoot = await enquiryModalFormRoot(modal);
  if (!(await isFollowUpRemarksFilled(formRoot))) return false;
  const followType = await readDropdownDisplayNearLabel(modal, FOLLOW_UP_TYPE_LABEL_RE);
  if (!/^phone$/i.test(followType.trim())) return false;
  const nextType = await readDropdownDisplayNearLabel(modal, /Next Follow Up Type/i);
  if (!/^phone$/i.test(nextType.trim())) return false;
  const verification = await readDropdownDisplayNearLabel(modal, /\*?\s*Verification/i);
  if (!/^y$/i.test(verification.trim())) return false;
  return isNextFollowUpTimeFilled(modal);
}

async function describeFollowUpReadiness(modal: Locator): Promise<string> {
  const formRoot = await enquiryModalFormRoot(modal);
  const parts: string[] = [];
  parts.push(`remarks=${(await isFollowUpRemarksFilled(formRoot)) ? "ok" : "missing"}`);
  parts.push(
    `followUpType="${(await readDropdownDisplayNearLabel(modal, FOLLOW_UP_TYPE_LABEL_RE)).trim() || "(empty)"}"`,
  );
  parts.push(
    `nextType="${(await readDropdownDisplayNearLabel(modal, /Next Follow Up Type/i)).trim() || "(empty)"}"`,
  );
  parts.push(
    `verification="${(await readDropdownDisplayNearLabel(modal, /\*?\s*Verification/i)).trim() || "(empty)"}"`,
  );
  parts.push(`nextTime=${(await isNextFollowUpTimeFilled(modal)) ? "ok" : "missing"}`);
  parts.push(
    `enquiryType="${(await readFollowUpEnquiryTypeDisplay(modal)).trim() || "(empty)"}"`,
  );
  return parts.join("; ");
}

async function followUpEnquiryTypeThenSaveOnly(
  page: Page,
  log: EnquiryTransferContext["log"],
  ctx: EnquiryTransferContext,
): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  await humanHoverClick(formRoot.getByText(/^Follow Up$/i));
  await pause("short");

  await log("info", "Follow Up already filled — Enquiry Type (once) then Save only.");
  await selectEnquiryTypeColdOnce(modal, log);
  await saveFollowUpUntilSuccess(page, log, ctx);
}

async function isFollowUpRemarksFilled(formRoot: Locator): Promise<boolean> {
  try {
    const remarks = await resolveFollowUpRemarksInput(formRoot);
    const t = (await remarks.inputValue().catch(() => "")).trim();
    return isAutomationRemarkFilled(t);
  } catch {
    return false;
  }
}

async function isNextFollowUpTimeFilled(modal: Locator): Promise<boolean> {
  const formRoot = await enquiryModalFormRoot(modal);
  const label = formRoot.locator("dt, th, td, label").filter({ hasText: /Next Follow Up Time/i }).first();
  if (!(await label.isVisible({ timeout: 1_500 }).catch(() => false))) return false;
  const container = label.locator(
    "xpath=ancestor::tr[1] | ancestor::dd[1] | ancestor::dl[1] | ancestor::*[contains(@class,'box_form')][1]",
  );
  const block = (await container.first().isVisible({ timeout: 500 }).catch(() => false))
    ? container.first()
    : label;

  const combined = (await block.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(combined) && /\d{1,2}:\d{2}/.test(combined)) {
    return true;
  }
  if (/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(combined) && /9:?\s*30\s*PM/i.test(combined)) {
    return true;
  }

  const displays = block.locator("span.k-input, .k-input-value, input[role='combobox'], input");
  const dn = await displays.count().catch(() => 0);
  for (let i = 0; i < dn; i++) {
    const el = displays.nth(i);
    const text = (await el.innerText().catch(() => "")).trim();
    const val = (await el.inputValue().catch(() => "")).trim();
    const blob = `${text} ${val}`;
    if (/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(blob) && (/\d{1,2}:\d{2}/.test(blob) || /9:?\s*30\s*PM/i.test(blob))) {
      return true;
    }
  }
  return false;
}

async function selectRandomReasonForNo(
  modal: Locator,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  await withModalInputBypass(modal, async () => {
    await openKendoDropdownNearLabel(modal, /Reason for No/i, log);
    const formRoot = await enquiryModalFormRoot(modal);
    const popup = formRoot
      .locator(".k-animation-container:visible, .k-popup:visible, .k-list-container:visible")
      .last();
    let items = popup.locator(".k-list-item, [role='option'], li");
    let n = await items.count();
    if (n < 1) {
      for (const ui of listUiContexts(modal.page())) {
        const p = ui.locator(".k-animation-container:visible, .k-popup:visible").last();
        items = p.locator(".k-list-item, [role='option'], li");
        n = await items.count();
        if (n > 0) break;
      }
    }
    const valid: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText().catch(() => "")).trim();
      if (t.length > 0 && !/^select$/i.test(t)) valid.push(i);
    }
    if (valid.length < 1) throw new Error("Reason for NO dropdown opened but no options listed");
    const pick = items.nth(valid[Math.floor(Math.random() * valid.length)]!);
    const label = (await pick.innerText().catch(() => "")).trim();
    await humanHoverClick(pick);
    await log("info", `Reason for NO selected: ${label || "(option)"}.`);
    await humanDelay();
  });
}

async function selectSalesConsultant(modal: Locator, consultant: string): Promise<void> {
  const words = consultant.split(/\s+/).filter(Boolean);
  const patterns: RegExp[] = [
    new RegExp(words.map(escapeRegExp).join("\\s+"), "i"),
    new RegExp(words.map(escapeRegExp).join(".*"), "i"),
    new RegExp(escapeRegExp(consultant.split(" ").slice(0, 2).join(" ")), "i"),
    new RegExp(escapeRegExp(words[0]!), "i"),
  ];
  let lastErr: unknown;
  for (const re of patterns) {
    try {
      await selectDropdownNearLabel(modal, /Sales Consultant/i, re);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`Could not select sales consultant: ${consultant}`);
}

async function isKendoTriggerDisabled(trigger: Locator): Promise<boolean> {
  if (await trigger.isDisabled().catch(() => false)) return true;
  const wrap = trigger.locator("xpath=ancestor::*[contains(@class,'k-dropdown')][1]").first();
  const cls = (await wrap.getAttribute("class").catch(() => "")) ?? "";
  if (cls.includes("k-state-disabled")) return true;
  return (await trigger.getAttribute("aria-disabled").catch(() => null)) === "true";
}

async function waitForReasonForNoEnabled(modal: Locator): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const trigger = await resolveKendoDropdownTriggerNearLabel(formRoot, /Reason for No/i);
      if (!(await isKendoTriggerDisabled(trigger))) return;
    } catch {
      /* not ready */
    }
    await pollDelay(400);
  }
  throw new Error("Reason for NO did not become enabled after TD Offer: No.");
}

/** PIN + TD Offer No + Reason for No already on this enquiry (saved from a prior pass on same modal). */
async function isBasicInfoTransferFieldsFilled(modal: Locator): Promise<boolean> {
  if (!(await mainFormPinHasValue(modal))) return false;
  const td = await readDropdownDisplayNearLabel(modal, /TD\s*Offer/i);
  if (!/\bno\b/i.test(td)) return false;
  const reason = await readDropdownDisplayNearLabel(modal, /Reason for No/i);
  const reasonTrim = reason.trim();
  if (!reasonTrim || /^select$/i.test(reasonTrim)) return false;
  return true;
}

async function applyRotatingSalesConsultant(
  modal: Locator,
  ctx: EnquiryTransferContext,
): Promise<void> {
  const { log } = ctx;
  const consultant = await pickNextSalesConsultant(prisma, ctx.redis, ctx);
  const pool = ctx.rotation?.consultants.length ?? 0;
  const tlNote = ctx.rotation ? ` (TL team, ${pool} SC${pool === 1 ? "" : "s"})` : "";
  await ensureBasicInfoTabActive(modal);
  await scrollKendoFieldIntoView(modal, /Sales Consultant/i);
  const before = (await readDropdownDisplayNearLabel(modal, /Sales Consultant/i)).trim();
  await log(
    "info",
    `Sales Consultant round-robin → ${consultant}${tlNote}${before ? ` (was "${before}")` : ""}.`,
  );
  await selectSalesConsultant(modal, consultant);
  const after = (await readDropdownDisplayNearLabel(modal, /Sales Consultant/i)).trim();
  if (!new RegExp(escapeRegExp(consultant.split(/\s+/).slice(0, 2).join(" ")), "i").test(after)) {
    throw new Error(
      `Sales Consultant verify failed after select (expected "${consultant}", display: "${after || "(empty)"}").`,
    );
  }
  await log("info", `Sales Consultant set: ${consultant}.`);
}

async function fillBasicInfoAfterPin(page: Page, ctx: EnquiryTransferContext): Promise<Locator> {
  const { log } = ctx;
  const modal = await resolveMainEnquiryBasicInfoModal(page, log);

  if (await isBasicInfoTransferFieldsFilled(modal)) {
    await log(
      "info",
      "Basic Info already has PIN / TD Offer / Reason — still updating Sales Consultant (round-robin).",
    );
    await applyRotatingSalesConsultant(modal, ctx);
    return modal;
  }

  await scrollKendoFieldIntoView(modal, /TD\s*Offer/i);
  const tdBefore = await readDropdownDisplayNearLabel(modal, /TD\s*Offer/i);
  if (/\bno\b/i.test(tdBefore)) {
    await log("info", `TD Offer already No ("${tdBefore}") — skipping select.`);
  } else {
    await log("info", "Basic Info — TD Offer: open dropdown, select No (ref 10).");
    await selectDropdownInFormRoot(modal, /TD\s*Offer/i, "No", log);
    const tdVal = await readDropdownDisplayNearLabel(modal, /TD\s*Offer/i);
    if (!/\bno\b/i.test(tdVal)) {
      throw new Error(`TD Offer verify failed after select (display: "${tdVal || "(empty)"}").`);
    }
    await log("info", "TD Offer set to No (verified).");
  }

  await waitForReasonForNoEnabled(modal);
  await scrollKendoFieldIntoView(modal, /Reason for No/i);
  const reasonBefore = await readDropdownDisplayNearLabel(modal, /Reason for No/i);
  if (reasonBefore.trim() && !/^select$/i.test(reasonBefore.trim())) {
    await log("info", `Reason for No already set ("${reasonBefore.trim()}") — skipping select.`);
  } else {
    await log("info", "Reason for No enabled — open list, pick random option (ref 11).");
    await selectRandomReasonForNo(modal, log);
    const reasonVal = await readDropdownDisplayNearLabel(modal, /Reason for No/i);
    if (!reasonVal.trim()) {
      throw new Error("Reason for NO verify failed — dropdown empty after select.");
    }
  }

  await applyRotatingSalesConsultant(modal, ctx);
  await log("info", "Basic Info fields done — clicking Save (#btnBasicSave) next.");
  return modal;
}

/** Save buttons sit in the Kendo window chrome; the form body is often in an iframe. */
async function resolveSaveButton(page: Page, preferFinal: boolean): Promise<Locator> {
  if (preferFinal) {
    try {
      return await resolveFollowUpSaveButton(page);
    } catch {
      /* fall through to legacy selectors */
    }
  }
  const ids = preferFinal ? (["btnFollowUpSave", "btnFinalSave"] as const) : (["btnBasicSave"] as const);
  const scopes: Locator[] = [];
  for (const id of ids) {
    for (const ui of listUiContexts(page)) {
      scopes.push(ui.locator(`.k-window:visible #${id}`).first());
      scopes.push(ui.locator(`#${id}`).first());
      scopes.push(
        ui
          .locator(".k-window, [role='dialog']")
          .filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i })
          .locator(`#${id}`)
          .first(),
      );
    }
    try {
      const modal = await visibleEnquiryModal(page);
      scopes.push(modal.locator(`#${id}`).first());
    } catch {
      /* modal not resolved yet */
    }
  }

  for (const candidate of scopes) {
    if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
      return candidate;
    }
  }

  if (preferFinal) {
    for (const ui of listUiContexts(page)) {
      const inModal = ui
        .locator(".k-window, [role='dialog']")
        .filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i })
        .locator("button.btn_save, button#btnFollowUpSave, button#btnFinalSave")
        .first();
      if (await inModal.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return inModal;
      }
      const saves = ui.getByRole("button", { name: /final\s+save/i });
      if (await saves.first().isVisible({ timeout: 1_000 }).catch(() => false)) {
        return saves.first();
      }
      const headerSave = ui
        .locator(".k-window:visible .header_btn button, .k-window:visible button.btn_save")
        .filter({ hasText: /^save$/i })
        .first();
      if (await headerSave.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return headerSave;
      }
    }
  } else {
    for (const ui of listUiContexts(page)) {
      const byRole = ui.getByRole("button", { name: /^save$/i });
      const n = await byRole.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const btn = byRole.nth(i);
        const btnId = (await btn.getAttribute("id").catch(() => "")) ?? "";
        if (btnId === "btnBasicSave" && (await btn.isVisible({ timeout: 500 }).catch(() => false))) {
          return btn;
        }
      }
    }
  }

  throw new Error(
    preferFinal
      ? "Follow Up Save (#btnFollowUpSave / #btnFinalSave) not found on enquiry modal"
      : "Basic Info Save (#btnBasicSave) not found on enquiry modal",
  );
}

async function clickSaveButton(target: Locator, log: EnquiryTransferContext["log"]): Promise<void> {
  await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await humanDelay(300, 700);
  await humanHoverClick(target);
  await humanDelay(400, 900);
  if (await target.isVisible({ timeout: 500 }).catch(() => false)) {
    const clicked = await target
      .evaluate((el) => {
        const btn = el as HTMLButtonElement;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
        btn.click();
        const jq = (window as unknown as { jQuery?: (n: Element) => { data: (k: string) => { trigger?: (e: string) => void } } })
          .jQuery;
        const widget = jq?.(btn)?.data("kendoButton");
        widget?.trigger?.("click");
        return true;
      })
      .catch(() => false);
    if (clicked) await log("info", "Save click sent via DOM (Kendo button fallback).");
  }
}

/** Follow Up form complete: remarks, Phone, Y, time, Enquiry Type = Cold (display on form). */
async function isFollowUpReadyForSave(modal: Locator): Promise<boolean> {
  if (!(await isFollowUpTabReadyExceptEnquiryType(modal))) return false;
  return isEnquiryTypeDisplayCold(modal);
}

/** #btnFollowUpSave lives on k-window chrome (outside enquiry iframe). */
async function resolveFollowUpSaveButton(page: Page): Promise<Locator> {
  const tryBtn = async (btn: Locator): Promise<Locator | null> => {
    if (!(await btn.isVisible({ timeout: 1_500 }).catch(() => false))) return null;
    const disabled = await btn.getAttribute("aria-disabled").catch(() => null);
    if (disabled === "true") return null;
    return btn;
  };

  for (const ui of listUiContexts(page)) {
    const scopes = [
      ui
        .locator(".k-window")
        .filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i })
        .locator("button#btnFollowUpSave, #btnFollowUpSave"),
      ui.locator(".header_btn.fr button#btnFollowUpSave, .header_btn.fr #btnFollowUpSave"),
      enquiryWindowWithFollowUpSaveIn(ui).locator("#btnFollowUpSave"),
      ui.locator("button#btnFollowUpSave.btn_m.btn_save"),
      ui.locator("#btnFinalSave:visible"),
    ];
    for (const scope of scopes) {
      const n = await scope.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const picked = await tryBtn(scope.nth(i));
        if (picked) return picked;
      }
    }

    const enquiryWin = ui.locator(".k-window").filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i }).last();
    if (await enquiryWin.isVisible({ timeout: 800 }).catch(() => false)) {
      const headerSave = enquiryWin.getByRole("button", { name: /^save$/i }).first();
      const picked = await tryBtn(headerSave);
      if (picked) return picked;
    }
  }

  const loose = page.locator("#btnFollowUpSave, #btnFinalSave").last();
  const picked = await tryBtn(loose);
  if (picked) return picked;

  throw new Error(
    "#btnFollowUpSave not visible on SALES CUSTOMER ENQUIRY INFO k-window (check top-right Save in popup chrome).",
  );
}

async function resolveEnquiryKendoWindow(page: Page): Promise<Locator> {
  for (const ui of listUiContexts(page)) {
    const win = enquiryWindowWithFollowUpSaveIn(ui)
      .filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i })
      .last();
    if (await win.isVisible({ timeout: 2_000 }).catch(() => false)) return win;
    const fallback = enquiryInfoModalIn(ui).filter({ hasText: /SALES CUSTOMER ENQUIRY INFO/i }).last();
    if (await fallback.isVisible({ timeout: 2_000 }).catch(() => false)) return fallback;
  }
  return visibleEnquiryModal(page);
}

async function waitForFollowUpReadyForSave(
  modal: Locator,
  log: EnquiryTransferContext["log"],
  timeoutMs = 12_000,
): Promise<void> {
  const page = modal.page();
  await closeDateTimePickerWithoutClosingModal(modal);
  await dismissTransientKendoPopups(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isFollowUpReadyForSave(modal)) {
      await log("info", "Follow Up data complete — ready for Save (#btnFollowUpSave).");
      return;
    }
    await dismissTransientKendoPopups(page);
    await pollDelay(350);
  }
  throw new Error(`Follow Up not ready for Save (${await describeFollowUpReadiness(modal)}).`);
}

async function waitBeforeFollowUpSave(log: EnquiryTransferContext["log"]): Promise<void> {
  const waitMs = randomBetween(FOLLOW_UP_SAVE_DELAY_MIN_MS, FOLLOW_UP_SAVE_DELAY_MAX_MS);
  await log(
    "info",
    `Follow Up data filled — random wait ${waitMs}ms (max ${FOLLOW_UP_SAVE_DELAY_MAX_MS}ms) before #btnFollowUpSave.`,
  );
  await new Promise((r) => setTimeout(r, waitMs));
}

async function kendoDateTimePickerPopupVisible(page: Page): Promise<boolean> {
  for (const root of listUiContexts(page)) {
    if (
      await root
        .locator(
          ".k-datetimepicker-popup:visible, .k-calendar-container:visible, .k-timeselector:visible, .k-datepicker-popup:visible",
        )
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
}

/** Close dropdown/list/calendar popups only — Escape closes the whole enquiry k-window if misused. */
async function dismissTransientKendoPopups(page: Page): Promise<void> {
  if (!(await kendoListPopupVisible(page)) && !(await kendoDateTimePickerPopupVisible(page))) {
    return;
  }
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(250, 450);
}

async function closeDateTimePickerWithoutClosingModal(modal: Locator): Promise<void> {
  if (!(await kendoDateTimePickerPopupVisible(modal.page()))) return;
  const formRoot = await enquiryModalFormRoot(modal);
  const anchor = formRoot.getByText(/^Follow Up History/i).first();
  if (await anchor.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await anchor.click({ force: true }).catch(() => {});
  } else {
    await formRoot.getByText(/^Follow Up$/i).first().click({ force: true }).catch(() => {});
  }
  await humanDelay(300, 600);
}

async function ensureFollowUpTabActive(modal: Locator): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const tab = formRoot.getByText(/^Follow Up$/i).first();
  if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await humanHoverClick(tab);
    await humanDelay(400, 800);
  }
}

async function ensureEnquiryModalOpenForFollowUpSave(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  if (!(await isAnyEnquiryModalVisible(page))) {
    throw new Error(
      "SALES CUSTOMER ENQUIRY INFO modal closed before Follow Up Save — do not press Escape on the enquiry window.",
    );
  }
  const modal = await visibleEnquiryModal(page);
  await modal.waitFor({ state: "visible", timeout: 9_000 });
  await ensureFollowUpTabActive(modal);
  await closeDateTimePickerWithoutClosingModal(modal);
  await dismissTransientKendoPopups(page);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await resolveFollowUpSaveButton(page);
      return modal;
    } catch {
      await ensureFollowUpTabActive(modal);
      await pollDelay(400);
    }
  }
  await log("warn", "Follow Up Save button not visible yet — re-activating Follow Up tab.");
  await ensureFollowUpTabActive(modal);
  return modal;
}

async function scrollFollowUpSaveIntoView(page: Page): Promise<void> {
  try {
    const saveBtn = await resolveFollowUpSaveButton(page);
    await saveBtn.scrollIntoViewIfNeeded({ timeout: 8_000 }).catch(() => {});
    const kWindow = await resolveEnquiryKendoWindow(page);
    await kWindow.evaluate((el) => {
      (el as HTMLElement).scrollTop = 0;
    }).catch(() => {});
  } catch {
    await page
      .evaluate(() => {
        const win = Array.from(document.querySelectorAll(".k-window")).find((w) =>
          /SALES CUSTOMER ENQUIRY INFO/i.test(w.textContent ?? ""),
        );
        const btn = win?.querySelector("#btnFollowUpSave");
        btn?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      })
      .catch(() => {});
  }
}

/** Click top-right Save on SALES CUSTOMER ENQUIRY INFO k-window (#btnFollowUpSave, outside iframe). */
async function clickBtnFollowUpSave(page: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  await ensureEnquiryModalOpenForFollowUpSave(page, log);
  await dismissTransientKendoPopups(page);

  const kWindow = await resolveEnquiryKendoWindow(page);
  const saveBtn = await resolveFollowUpSaveButton(page);

  await kWindow.evaluate((el) => {
    (el as HTMLElement).scrollTop = 0;
  }).catch(() => {});
  await saveBtn.scrollIntoViewIfNeeded({ timeout: 7_000 }).catch(() => {});
  await humanDelay(300, 600);

  const box = await saveBtn.boundingBox();
  if (box && box.width > 2 && box.height > 2) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await log("info", `Follow Up Save — mouse click #btnFollowUpSave at (${Math.round(x)}, ${Math.round(y)}).`);
    await page.mouse.move(x, y);
    await microDelay();
    await page.mouse.down();
    await microDelay();
    await page.mouse.up();
    await humanDelay(250, 500);
  } else {
    const winBox = await kWindow.boundingBox();
    if (winBox) {
      const x = winBox.x + winBox.width - 52;
      const y = winBox.y + 36;
      await log(
        "info",
        `Follow Up Save — mouse click top-right of enquiry k-window (${Math.round(x)}, ${Math.round(y)}).`,
      );
      await page.mouse.click(x, y);
      await humanDelay(250, 500);
    }
  }

  await log("info", "Follow Up Save — Playwright + jQuery click on #btnFollowUpSave.");
  try {
    await saveBtn.click({ force: true, timeout: scaleMs(8_000) });
  } catch (err) {
    if (!isPlaywrightDetachError(err)) throw err;
    await log(
      "warn",
      "Follow Up Save — Playwright click stopped: frame detached (CRM often closes the modal right after save).",
    );
  }
  await saveBtn
    .evaluate((el) => {
      const b = el as HTMLButtonElement;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      b.focus();
      const jq = (window as unknown as {
        jQuery?: (n: Element) => {
          trigger?: (e: string) => void;
          click?: () => void;
          data: (k: string) => { trigger?: (e: string) => void };
        };
      }).jQuery;
      if (jq) {
        const $b = jq(b);
        $b.trigger?.("click");
        $b.click?.();
        $b.data("kendoButton")?.trigger?.("click");
      }
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      b.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      b.click();
      return true;
    })
    .catch(() => false);

  await humanDelay(500, 1_000);
}

async function saveFollowUpUntilSuccess(
  page: Page,
  log: EnquiryTransferContext["log"],
  ctx: EnquiryTransferContext,
): Promise<void> {
  let modal = await ensureEnquiryModalOpenForFollowUpSave(page, log);
  if (!(await isEnquiryTypeDisplayCold(modal))) {
    throw new Error('Follow Up Save blocked — Enquiry Type must show Cold (type "c" + Enter first).');
  }
  try {
    await waitForFollowUpReadyForSave(modal, log, 10_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("warn", `${msg} — attempting #btnFollowUpSave anyway (Enquiry Type=Cold).`);
  }
  await waitBeforeFollowUpSave(log);

  for (let attempt = 1; attempt <= env.GDMS_SAVE_MAX_ATTEMPTS; attempt++) {
    try {
      await withPageInputBypass(page, async () => {
        modal = await ensureEnquiryModalOpenForFollowUpSave(page, log);
        await closeDateTimePickerWithoutClosingModal(modal);
        await dismissTransientKendoPopups(page);
        await scrollFollowUpSaveIntoView(page);
        await clickBtnFollowUpSave(page, log);
      });
    } catch (err) {
      if (!isPlaywrightDetachError(err)) throw err;
      await log(
        "warn",
        `Follow Up Save attempt ${attempt} — frame detached during click; checking if CRM already saved and closed the modal.`,
      );
    }
    await humanDelay(
      env.GDMS_SAVE_RETRY_INTERVAL_MS,
      env.GDMS_SAVE_RETRY_INTERVAL_MS + scaleMs(2800),
    );
    if (await confirmFollowUpSaveSucceeded(page, log)) {
      await log("info", "Follow Up Save succeeded (#btnFollowUpSave).");
      return;
    }
    await log("warn", `Follow Up Save attempt ${attempt} — no success toast or list dismiss yet.`);
    if (attempt < env.GDMS_SAVE_MAX_ATTEMPTS) {
      await waitBeforeFollowUpSave(log);
    }
  }
  await ctx.signalManualIntervention(
    `Follow Up Save (#btnFollowUpSave) failed after ${env.GDMS_SAVE_MAX_ATTEMPTS} attempts.`,
  );
}

async function isSuccessToastVisible(page: Page): Promise<boolean> {
  for (const ui of listUiContexts(page)) {
    if (await ui.getByText(SUCCESS_TOAST).first().isVisible({ timeout: 800 }).catch(() => false)) {
      return true;
    }
  }
  return page.getByText(SUCCESS_TOAST).first().isVisible({ timeout: 800 }).catch(() => false);
}

/** CRM may close the enquiry k-window before the success toast is readable on the list. */
async function confirmFollowUpSaveSucceeded(
  page: Page,
  log: EnquiryTransferContext["log"],
  waitMs = 14_000,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isSuccessToastVisible(page)) return true;
    if (
      !(await isAnyEnquiryModalVisible(page)) &&
      (await isOnCustomerEnquiryList(page))
    ) {
      await log(
        "info",
        "Follow Up Save — modal closed and Customer Enquiry list visible (treating save as successful).",
      );
      return true;
    }
    await pollDelay(350);
  }
  return false;
}

async function clickVisibleSaveInModal(
  page: Page,
  log: EnquiryTransferContext["log"],
  preferFinal = false,
): Promise<void> {
  await visibleEnquiryModal(page).then((m) => m.waitFor({ state: "visible", timeout: 4_000 }));
  const target = await resolveSaveButton(page, preferFinal);
  const btnId = (await target.getAttribute("id").catch(() => "")) ?? "";
  if (preferFinal) {
    await log("info", `Clicking Follow Up Save (${btnId || "#btnFollowUpSave"}).`);
  } else {
    await log("info", "Clicking Basic Info Save (#btnBasicSave).");
  }
  await withPageInputBypass(page, async () => {
    await clickSaveButton(target, log);
  });
}

async function saveUntilSuccess(
  page: Page,
  log: EnquiryTransferContext["log"],
  ctx: EnquiryTransferContext,
  preferFinalSave = false,
): Promise<void> {
  for (let attempt = 1; attempt <= env.GDMS_SAVE_MAX_ATTEMPTS; attempt++) {
    await clickVisibleSaveInModal(page, log, preferFinalSave);
    await humanDelay(
      env.GDMS_SAVE_RETRY_INTERVAL_MS,
      env.GDMS_SAVE_RETRY_INTERVAL_MS + scaleMs(2800),
    );
    if (await isSuccessToastVisible(page)) {
      await log("info", "Save succeeded (success toast visible).");
      return;
    }
    await log("warn", `Save attempt ${attempt} — waiting for success toast.`);
  }
  await ctx.signalManualIntervention(
    `Save failed after ${env.GDMS_SAVE_MAX_ATTEMPTS} attempts — manual intervention required (no success toast).`,
  );
}

function istDateParts(date: Date): { day: number; month: number; year: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { day: get("day"), month: get("month"), year: get("year"), hour: get("hour") };
}

/** 0 = Sunday … 6 = Saturday (Asia/Kolkata). */
function istDayOfWeek(year: number, month: number, day: number): number {
  const midnightIstUtc = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(midnightIstUtc));
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 0;
}

/** Shift IST calendar date by N days without using server local timezone. */
function addIstCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { day: number; month: number; year: number } {
  const midnightIstUtc = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  const shifted = new Date(midnightIstUtc + days * 86_400_000);
  const { day: d, month: m, year: y } = istDateParts(shifted);
  return { day: d, month: m, year: y };
}

/**
 * Next Follow Up calendar date (IST):
 * - 12:00 AM–1:59 PM → same day @ 9:30 PM
 * - 2:00 PM–11:59 PM → next calendar day @ 9:30 PM
 * - Sunday (any time) → always Monday (never same-day Sunday)
 * - If target date is Sunday (e.g. Saturday after 2 PM) → skip to Monday
 */
function nextFollowUpDateIst(now = new Date()): {
  day: number;
  month: number;
  year: number;
} {
  const { day, month, year, hour } = istDateParts(now);
  const transferDow = istDayOfWeek(year, month, day);

  let addDays: number;
  if (transferDow === 0) {
    addDays = 1;
  } else {
    addDays = hour >= 14 ? 1 : 0;
  }

  let target = addIstCalendarDays(year, month, day, addDays);
  while (istDayOfWeek(target.year, target.month, target.day) === 0) {
    target = addIstCalendarDays(target.year, target.month, target.day, 1);
  }
  return target;
}

function parseCalendarHeader(text: string): { month: number; year: number } | null {
  const t = text.trim().toLowerCase();
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (t.includes(MONTH_NAMES[i]!)) {
      const yearMatch = t.match(/\b(20\d{2})\b/);
      if (yearMatch) return { month: i + 1, year: Number(yearMatch[1]) };
    }
  }
  const numeric = t.match(/\b(\d{1,2})\D+(20\d{2})\b/);
  if (numeric) return { month: Number(numeric[1]), year: Number(numeric[2]) };
  return null;
}

async function resolveNextFollowUpTimeRow(formRoot: Locator): Promise<Locator> {
  const label = formRoot.locator("dt, th, td, label").filter({ hasText: /^Next Follow Up Time/i }).first();
  await label.waitFor({ state: "visible", timeout: 4_000 });
  const row = label.locator("xpath=ancestor::tr[1]");
  if (await row.isVisible({ timeout: 1_000 }).catch(() => false)) return row;
  const dl = label.locator("xpath=ancestor::dl[1]");
  if (await dl.isVisible({ timeout: 1_000 }).catch(() => false)) return dl;
  return label.locator("xpath=ancestor::*[contains(@class,'box_form')][1]");
}

async function clickNextFollowUpCalendarTrigger(row: Locator, log: EnquiryTransferContext["log"]): Promise<void> {
  const candidates = [
    row.locator(".k-datepicker .k-select").first(),
    row.locator(".k-picker-wrap .k-select").first(),
    row.locator("span.k-select").first(),
    row.locator("[class*='k-i-calendar']").first(),
    row.locator("button[class*='calendar'], a[class*='calendar']").first(),
  ];
  for (const trigger of candidates) {
    if (await trigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await humanHoverClick(trigger);
      await log("info", "Next Follow Up Time — opened date picker (calendar icon).");
      return;
    }
  }
  const label = row.locator("dt, th, td").filter({ hasText: /^Next Follow Up Time/i }).first();
  const fallback = label.locator(
    "xpath=following::span[contains(@class,'k-select')][1] | following::button[1] | following::img[1]",
  );
  await humanHoverClick(fallback.first());
  await log("info", "Next Follow Up Time — opened date picker (fallback trigger).");
}

async function clickNextFollowUpClockTrigger(row: Locator, log: EnquiryTransferContext["log"]): Promise<void> {
  const candidates = [
    row.locator(".k-timepicker .k-select").first(),
    row.locator("[class*='k-i-clock']").first(),
    row.locator("button[class*='clock'], a[class*='clock']").first(),
  ];
  for (const trigger of candidates) {
    if (await trigger.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await humanHoverClick(trigger);
      await log("info", "Next Follow Up Time — opened / focused time list (clock icon).");
      return;
    }
  }
}

async function findVisibleDateTimePicker(page: Page): Promise<Locator> {
  for (const ui of listUiContexts(page)) {
    const popup = ui.locator(".k-datetimepicker-popup:visible, .k-animation-container:visible").last();
    if (await popup.isVisible({ timeout: 800 }).catch(() => false)) return popup;
    const cal = ui.locator(".k-calendar:visible").last();
    if (await cal.isVisible({ timeout: 800 }).catch(() => false)) return cal;
  }
  return page.locator(".k-animation-container:visible, .k-datetimepicker-popup:visible").last();
}

/** Kendo time list starts at 12:00 AM — scroll until 9:30 PM is visible, then click. */
async function selectTime930PmInPicker(page: Page, log: EnquiryTransferContext["log"]): Promise<void> {
  const timePatterns = [/9:30\s*PM/i, /9\.30\s*PM/i, /^21:30$/i];
  let listScroller: Locator | null = null;

  for (const ui of listUiContexts(page)) {
    for (const sel of [
      ".k-timeselector .k-list-content",
      ".k-timeselector .k-list",
      ".k-time-list",
      ".k-list-scroller",
      "ul.k-list:visible",
      ".k-animation-container:visible .k-list",
    ]) {
      const list = ui.locator(sel).last();
      if (await list.isVisible({ timeout: 600 }).catch(() => false)) {
        listScroller = list;
        break;
      }
    }
    if (listScroller) break;
  }

  await log("info", "Next Follow Up Time — scrolling time list to 9:30 PM.");

  for (let attempt = 0; attempt < 48; attempt++) {
    for (const ui of listUiContexts(page)) {
      for (const pattern of timePatterns) {
        const items = ui.locator("li, .k-list-item, [role='option']").filter({ hasText: pattern });
        const n = await items.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const item = items.nth(i);
          if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
          await item.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
          await humanHoverClick(item);
          await log("info", "Next Follow Up Time — selected 9:30 PM.");
          return;
        }
        const byText = ui.getByText(pattern).first();
        if (await byText.isVisible({ timeout: 300 }).catch(() => false)) {
          await byText.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
          await humanHoverClick(byText);
          await log("info", "Next Follow Up Time — selected 9:30 PM.");
          return;
        }
      }
    }

    if (listScroller) {
      await listScroller.evaluate((el) => {
        el.scrollTop += Math.max(80, Math.floor(el.clientHeight * 0.85));
      });
    } else {
      await page.mouse.wheel(0, 140);
    }
    await pause("short");
  }

  throw new Error("9:30 PM not found in time picker — scrolled time list but option did not appear.");
}

async function navigateCalendarToDate(
  picker: Locator,
  target: { day: number; month: number; year: number },
): Promise<void> {
  for (let step = 0; step < 24; step++) {
    const header = picker
      .locator(
        ".k-calendar-header, .k-nav-fast, .k-title, [class*='calendar-header'], [class*='calendar-title']",
      )
      .first();
    const headerText = (await header.innerText().catch(() => "")).trim();
    const current = parseCalendarHeader(headerText);
    if (current?.month === target.month && current.year === target.year) return;

    const goForward =
      !current ||
      current.year < target.year ||
      (current.year === target.year && current.month < target.month);

    const navBtn = goForward
      ? picker
          .locator(".k-nav-next, [aria-label*='next' i], [title*='next' i]")
          .or(picker.getByRole("button", { name: />|next/i }))
          .first()
      : picker
          .locator(".k-nav-prev, [aria-label*='prev' i], [title*='prev' i]")
          .or(picker.getByRole("button", { name: /<|prev/i }))
          .first();

    if (!(await navBtn.count())) break;
    await navBtn.click({ timeout: 5_000 });
    await microDelay();
  }
}

async function resolveFollowUpRemarksInput(formRoot: Locator): Promise<Locator> {
  const label = formRoot.locator("dt, th, td, label").filter({ hasText: /^Follow Up Remarks/i }).first();
  if (await label.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const row = label.locator("xpath=ancestor::tr[1]");
    const inRow = row.locator("textarea").first();
    if (await inRow.isVisible({ timeout: 1_500 }).catch(() => false)) return inRow;
    const dd = label.locator("xpath=following-sibling::dd[1]");
    const inDd = dd.locator("textarea").first();
    if (await inDd.isVisible({ timeout: 1_500 }).catch(() => false)) return inDd;
    const following = label.locator("xpath=following::textarea[1]");
    if (await following.isVisible({ timeout: 1_500 }).catch(() => false)) return following;
  }
  const byLabel = formRoot.getByLabel(/Follow Up Remarks/i).first();
  if (await byLabel.isVisible({ timeout: 2_000 }).catch(() => false)) return byLabel;
  throw new Error("Follow Up Remarks textarea not found (will not use Scheme Offered or other fields).");
}

/** Follow Up Skip: click remarks (cursor at end), type remark + automation suffix, then blur toward Follow Up Type. */
async function fillFollowUpRemarksForSkip(
  page: Page,
  modal: Locator,
  formRoot: Locator,
  log: EnquiryTransferContext["log"],
  remarkText: string,
): Promise<void> {
  const remarks = await resolveFollowUpRemarksInput(formRoot);
  await remarks.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});

  await withModalInputBypass(modal, async () => {
    await remarks.click({ timeout: scaleMs(10_000) });
    await remarks.fill(remarkText);
    await humanDelay(350, 600);

    const box = await remarks.boundingBox();
    if (box && box.width > 4 && box.height > 4) {
      await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10);
      await log("info", "Follow Up Remarks — clicked end of field (cursor position).");
    } else {
      await remarks.click();
      await remarks.press("End").catch(() => {});
    }
    await humanDelay(300, 550);

    const typeHint = formRoot
      .locator("td, th, dt, label, span")
      .filter({ hasText: /^Follow Up Type/i })
      .filter({ hasNotText: /Next/i })
      .first();
    if (await typeHint.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await typeHint.click({ force: true, timeout: scaleMs(8_000) });
      await log("info", "Follow Up Remarks done — focus moved to Follow Up Type.");
    } else {
      await page.keyboard.press("Tab").catch(() => {});
    }
  });

  await log("info", `Follow Up Remarks = "${remarkText}".`);
}

async function setNextFollowUpTime(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  const target = nextFollowUpDateIst();
  const { hour } = istDateParts(new Date());
  await log(
    "info",
    `Next Follow Up date ${target.day}/${target.month}/${target.year} @ 9:30 PM IST (transfer hour ${hour}; Sun→Mon, no Sunday dates).`,
  );

  const row = await resolveNextFollowUpTimeRow(formRoot);
  await row.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});

  await withModalInputBypass(modal, async () => {
    await clickNextFollowUpCalendarTrigger(row, log);
  });
  await pause("normal");

  const picker = await findVisibleDateTimePicker(page);
  await picker.waitFor({ state: "visible", timeout: 4_000 });

  const calendar = picker.locator(".k-calendar").first();
  const calendarRoot = (await calendar.isVisible({ timeout: 2_000 }).catch(() => false))
    ? calendar
    : picker;

  await log("info", `Next Follow Up Time — picking date ${target.day}/${target.month}/${target.year}.`);
  await navigateCalendarToDate(calendarRoot, target);

  const dayCell = calendarRoot
    .locator("td:not(.k-other-month):not(.k-state-disabled), [role='gridcell']:not([aria-disabled='true'])")
    .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
    .first();
  await dayCell.click({ timeout: 6_000 });
  await pause("short");
  await log("info", "Next Follow Up Time — date selected; setting time 9:30 PM.");

  let timeVisible = false;
  for (const pattern of [/9:30\s*PM/i, /9\.30\s*PM/i]) {
    if (await page.getByText(pattern).first().isVisible({ timeout: 600 }).catch(() => false)) {
      timeVisible = true;
      break;
    }
  }
  if (!timeVisible) {
    await withModalInputBypass(modal, async () => {
      await clickNextFollowUpClockTrigger(row, log);
    });
    await pause("short");
  }

  await withModalInputBypass(modal, async () => {
    await selectTime930PmInPicker(page, log);
  });
  await closeDateTimePickerWithoutClosingModal(modal);
  await pause("short");
}

async function completeFollowUpTab(page: Page, log: EnquiryTransferContext["log"], ctx: EnquiryTransferContext): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  await humanHoverClick(formRoot.getByText(/^Follow Up$/i));
  await pause("short");

  if (await isFollowUpTabReadyExceptEnquiryType(modal)) {
    await followUpEnquiryTypeThenSaveOnly(page, log, ctx);
    return;
  }

  await log("info", "Follow Up tab — fill missing fields, Enquiry Type once, then Save.");
  await pause("normal");

  const remarkText = await resolveEnquiryFollowUpRemark(page, ctx);
  if (await isFollowUpRemarksFilled(formRoot)) {
    await log("info", `Follow Up Remarks already set (automation suffix) — skipping re-type.`);
  } else {
    const remarks = await resolveFollowUpRemarksInput(formRoot);
    await remarks.scrollIntoViewIfNeeded({ timeout: 6_000 }).catch(() => {});
    await withModalInputBypass(modal, async () => {
      await remarks.click();
      await remarks.fill("");
      await remarks.pressSequentially(remarkText, { delay: scaledRandomBetween(80, 140) });
    });
    await log("info", `Follow Up Remarks set to "${remarkText}" (Scheme Offered left empty).`);
    await pause("normal");
  }

  const followType = await readDropdownDisplayNearLabel(modal, FOLLOW_UP_TYPE_LABEL_RE);
  if (/^phone$/i.test(followType.trim())) {
    await log("info", "Follow Up Type already Phone — skipping.");
  } else {
    await selectDropdownNearLabel(modal, FOLLOW_UP_TYPE_LABEL_RE, /^Phone$/i);
    await pause("normal");
  }

  const nextType = await readDropdownDisplayNearLabel(modal, /Next Follow Up Type/i);
  if (/^phone$/i.test(nextType.trim())) {
    await log("info", "Next Follow Up Type already Phone — skipping.");
  } else {
    await selectDropdownNearLabel(modal, /Next Follow Up Type/i, /^Phone$/i);
    await pause("normal");
  }

  await selectMandatoryVerificationY(modal);
  await pause("normal");

  if (await isNextFollowUpTimeFilled(modal)) {
    await log("info", "Next Follow Up Time already set — skipping calendar.");
  } else {
    await setNextFollowUpTime(page, log);
  }
  await pause("normal");

  await scrollEnquiryInfoBottomIntoView(modal);
  await pause("short");

  await selectEnquiryTypeColdOnce(modal, log);
  await saveFollowUpUntilSuccess(page, log, ctx);
}

/** @deprecated use pickRandomFollowUpRemark + formatAutomationRemark from settings */
export const FOLLOW_UP_SKIP_REMARKS = formatAutomationRemark("");

/**
 * Next Follow Up date for skip flow (IST): tomorrow @ 9:30 PM;
 * Saturday → Monday (skip Sunday).
 */
export function followUpSkipNextDateIst(now = new Date()): {
  day: number;
  month: number;
  year: number;
} {
  const { day, month, year } = istDateParts(now);
  const dow = istDayOfWeek(year, month, day);
  let addDays = dow === 6 ? 2 : 1;
  let target = addIstCalendarDays(year, month, day, addDays);
  while (istDayOfWeek(target.year, target.month, target.day) === 0) {
    target = addIstCalendarDays(target.year, target.month, target.day, 1);
  }
  return target;
}

export type FollowUpSkipContext = Pick<
  EnquiryTransferContext,
  "log" | "shouldStop" | "waitIfPaused" | "signalManualIntervention"
> & {
  followUpSkipRemarkBases: string[];
};

async function readFollowUpSkipDropdownDisplay(modal: Locator, label: RegExp): Promise<string> {
  try {
    const formRoot = await enquiryModalFormRoot(modal);
    const fieldsRoot = await resolveFollowUpFieldsContainer(formRoot);
    const trigger = await resolveFollowUpSkipKendoDropdownTriggerNearLabel(fieldsRoot, label);
    const host = trigger.locator("xpath=ancestor::*[contains(@class,'k-dropdown')][1]");
    const display = host.locator("span.k-input, .k-input-value, input[role='combobox'], input").first();
    if (await display.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const text = (await display.innerText().catch(() => "")).trim();
      if (text) return text;
      return (await display.inputValue().catch(() => "")).trim();
    }
  } catch {
    /* fall through */
  }
  return readDropdownDisplayNearLabel(modal, label);
}

async function openFollowUpSkipKendoDropdownNearLabel(
  modal: Locator,
  label: RegExp,
  log?: EnquiryTransferContext["log"],
): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const fieldsRoot = await resolveFollowUpFieldsContainer(formRoot);
  const trigger = await resolveFollowUpSkipKendoDropdownTriggerNearLabel(fieldsRoot, label);
  await trigger.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});
  if (log) await log("info", `Opening ${String(label)} dropdown (Follow Up Skip).`);

  const page = modal.page();
  const host = trigger.locator("xpath=ancestor::*[contains(@class,'k-dropdown')][1]");
  const kInput = host.locator("span.k-input").first();
  const kSelect = host.locator("span.k-select").first();

  const tryOpen = async (): Promise<boolean> => {
    if (await kendoListPopupVisible(page)) return true;
    for (const target of [kInput, kSelect, host.locator(".k-dropdown-wrap").first(), trigger]) {
      if (!(await target.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await target.click({ force: true, timeout: scaleMs(10_000) });
      await humanDelay(450, 900);
      if (await kendoListPopupVisible(page)) return true;
    }
    await tryOpenKendoWidgetViaDom(trigger);
    await humanDelay(400, 900);
    return kendoListPopupVisible(page);
  };

  if (!(await tryOpen())) {
    throw new Error(`Kendo list did not open for ${String(label)} (Follow Up Skip).`);
  }
}

/** Type P in list filter (or keyboard) and confirm Phone — Follow Up Skip only. */
async function typeaheadPhoneInOpenKendoList(page: Page): Promise<void> {
  for (const ui of listUiContexts(page)) {
    const filter = ui
      .locator(
        ".k-list-filter input, .k-animation-container:visible .k-list-filter input, .k-popup:visible input[type='text']",
      )
      .first();
    if (!(await filter.isVisible({ timeout: 900 }).catch(() => false))) continue;
    await filter.click({ force: true });
    await filter.fill("");
    await filter.pressSequentially("p", { delay: scaledRandomBetween(80, 130) });
    await humanDelay(300, 550);
    const phoneItem = ui
      .locator(
        ".k-list-container:visible .k-list-item, .k-popup:visible .k-list-item, ul.k-list:visible li",
      )
      .filter({ hasText: /^phone$/i })
      .first();
    if (await phoneItem.isVisible({ timeout: 2_500 }).catch(() => false)) {
      await phoneItem.click({ force: true });
      return;
    }
    await filter.press("Enter");
    return;
  }
  await page.keyboard.press("p");
  await humanDelay(280, 500);
  await page.keyboard.press("Enter");
}

async function selectFollowUpSkipPhoneDropdown(
  page: Page,
  modal: Locator,
  label: RegExp,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const current = (await readFollowUpSkipDropdownDisplay(modal, label)).trim();
  if (/^phone$/i.test(current)) {
    await log("info", `${String(label)} already Phone — skipping.`);
    return;
  }

  await log("info", `${String(label)} — click dropdown, type P, Enter.`);
  await withModalInputBypass(modal, async () => {
    await dismissTransientKendoPopups(page);
    await openFollowUpSkipKendoDropdownNearLabel(modal, label, log);
    await typeaheadPhoneInOpenKendoList(page);
    await humanDelay(400, 750);
    await dismissTransientKendoPopups(page);
  });

  let after = (await readFollowUpSkipDropdownDisplay(modal, label)).trim();
  if (!/^phone$/i.test(after)) {
    await log(
      "warn",
      `${String(label)} typeahead did not show Phone (display="${after || "(empty)"}") — picking Phone from list.`,
    );
    await withModalInputBypass(modal, async () => {
      await dismissTransientKendoPopups(page);
      await openFollowUpSkipKendoDropdownNearLabel(modal, label, log);
      const formRoot = await enquiryModalFormRoot(modal);
      await clickOptionInFormRoot(formRoot, /^Phone$/i);
      await dismissTransientKendoPopups(page);
    });
    after = (await readFollowUpSkipDropdownDisplay(modal, label)).trim();
  }
  if (!/^phone$/i.test(after)) {
    throw new Error(`${String(label)} is not Phone after select (display="${after || "(empty)"}").`);
  }
  await log("info", `${String(label)} = Phone.`);
}

async function isFollowUpSkipReadyForSave(modal: Locator): Promise<boolean> {
  const formRoot = await enquiryModalFormRoot(modal);
  try {
    const remarks = await resolveFollowUpRemarksInput(formRoot);
    const t = (await remarks.inputValue().catch(() => "")).trim();
    if (!isAutomationRemarkFilled(t)) return false;
  } catch {
    return false;
  }
  if (!/^phone$/i.test((await readFollowUpSkipDropdownDisplay(modal, FOLLOW_UP_TYPE_LABEL_RE)).trim())) {
    return false;
  }
  if (!/^phone$/i.test((await readFollowUpSkipDropdownDisplay(modal, /Next Follow Up Type/i)).trim())) {
    return false;
  }
  return isNextFollowUpTimeFilled(modal);
}

async function waitForFollowUpSkipReadyForSave(
  modal: Locator,
  log: EnquiryTransferContext["log"],
  timeoutMs = 12_000,
): Promise<void> {
  const page = modal.page();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isFollowUpSkipReadyForSave(modal)) {
      await log("info", "Follow Up Skip form complete — ready for Save.");
      return;
    }
    await dismissTransientKendoPopups(page);
    await pollDelay(350);
  }
  throw new Error(`Follow Up Skip not ready for Save (${await describeFollowUpReadiness(modal)}).`);
}

async function setNextFollowUpTimeForSkip(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  const target = followUpSkipNextDateIst();
  await log(
    "info",
    `Next Follow Up (skip) — ${target.day}/${target.month}/${target.year} @ 9:30 PM IST (Sat→Mon, no Sunday).`,
  );

  const row = await resolveNextFollowUpTimeRow(formRoot);
  await row.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => {});

  await withModalInputBypass(modal, async () => {
    await clickNextFollowUpCalendarTrigger(row, log);
  });
  await pause("normal");

  const picker = await findVisibleDateTimePicker(page);
  await picker.waitFor({ state: "visible", timeout: 4_000 });
  const calendar = picker.locator(".k-calendar").first();
  const calendarRoot = (await calendar.isVisible({ timeout: 2_000 }).catch(() => false))
    ? calendar
    : picker;

  await navigateCalendarToDate(calendarRoot, target);
  const dayCell = calendarRoot
    .locator("td:not(.k-other-month):not(.k-state-disabled), [role='gridcell']:not([aria-disabled='true'])")
    .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
    .first();
  await dayCell.click({ timeout: 6_000 });
  await pause("short");

  let timeVisible = false;
  for (const pattern of [/9:30\s*PM/i, /9\.30\s*PM/i]) {
    if (await page.getByText(pattern).first().isVisible({ timeout: 600 }).catch(() => false)) {
      timeVisible = true;
      break;
    }
  }
  if (!timeVisible) {
    await withModalInputBypass(modal, async () => {
      await clickNextFollowUpClockTrigger(row, log);
    });
    await pause("short");
  }

  await withModalInputBypass(modal, async () => {
    await selectTime930PmInPicker(page, log);
  });
  await closeDateTimePickerWithoutClosingModal(modal);
  await pause("short");
}

/** Fill Follow Up tab on enquiry modal for Today's Follow Up skip (no Basic Info / PIN). */
export async function completeFollowUpTabForSkip(
  page: Page,
  ctx: FollowUpSkipContext,
): Promise<void> {
  const { log } = ctx;
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  await humanHoverClick(formRoot.getByText(/^Follow Up$/i));
  await pause("short");
  await log("info", "Follow Up tab — filling remarks, types (P), next time, then Save.");

  const skipBase = pickRandomFollowUpRemark(ctx.followUpSkipRemarkBases);
  const skipRemarkText = formatAutomationRemark(skipBase);
  await fillFollowUpRemarksForSkip(page, modal, formRoot, log, skipRemarkText);
  await pause("normal");

  await dismissTransientKendoPopups(page);
  await selectFollowUpSkipPhoneDropdown(page, modal, FOLLOW_UP_TYPE_LABEL_RE, log);
  await pause("normal");
  await selectFollowUpSkipPhoneDropdown(page, modal, /Next Follow Up Type/i, log);
  await pause("normal");

  if (!(await isNextFollowUpTimeFilled(modal))) {
    await log("info", "Next Follow Up Time — opening calendar.");
    await setNextFollowUpTimeForSkip(page, log);
  } else {
    await log("info", "Next Follow Up Time already set — skipping.");
  }
  await pause("normal");

  if (!(await isEnquiryTypeDisplayCold(modal))) {
    await scrollEnquiryInfoBottomIntoView(modal);
    try {
      await selectEnquiryTypeColdOnce(modal, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log("warn", `Enquiry Type Cold optional step failed: ${msg} — continuing to Save.`);
    }
  } else {
    await log("info", "Enquiry Type already Cold — skipping.");
  }
  await saveFollowUpSkipUntilSuccess(page, log, ctx);
}

async function saveFollowUpSkipUntilSuccess(
  page: Page,
  log: EnquiryTransferContext["log"],
  ctx: FollowUpSkipContext,
): Promise<void> {
  let modal = await ensureEnquiryModalOpenForFollowUpSave(page, log);
  try {
    await waitForFollowUpSkipReadyForSave(modal, log, 10_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log("warn", `${msg} — attempting Follow Up Save anyway.`);
  }
  await waitBeforeFollowUpSave(log);

  for (let attempt = 1; attempt <= env.GDMS_SAVE_MAX_ATTEMPTS; attempt++) {
    try {
      await withPageInputBypass(page, async () => {
        modal = await ensureEnquiryModalOpenForFollowUpSave(page, log);
        await closeDateTimePickerWithoutClosingModal(modal);
        await dismissTransientKendoPopups(page);
        await scrollFollowUpSaveIntoView(page);
        await clickBtnFollowUpSave(page, log);
      });
    } catch (err) {
      if (!isPlaywrightDetachError(err)) throw err;
      await log("warn", `Follow Up Save attempt ${attempt} — frame detached; checking CRM state.`);
    }
    await humanDelay(
      env.GDMS_SAVE_RETRY_INTERVAL_MS,
      env.GDMS_SAVE_RETRY_INTERVAL_MS + scaleMs(2800),
    );
    if (await confirmFollowUpSkipSaveSucceeded(page, log)) {
      await log("info", "Follow Up Save succeeded (skip flow).");
      return;
    }
    await log("warn", `Follow Up Save attempt ${attempt} — no success yet.`);
    if (attempt < env.GDMS_SAVE_MAX_ATTEMPTS) await waitBeforeFollowUpSave(log);
  }
  await ctx.signalManualIntervention(
    `Follow Up Save failed after ${env.GDMS_SAVE_MAX_ATTEMPTS} attempts (Today's Follow Up skip).`,
  );
}

async function confirmFollowUpSkipSaveSucceeded(
  page: Page,
  log: EnquiryTransferContext["log"],
  waitMs = 14_000,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isSuccessToastVisible(page)) return true;
    if (!(await isAnyEnquiryModalVisible(page)) && (await isOnTodaysFollowUpList(page))) {
      await log("info", "Follow Up Save — modal closed; Today's Follow Up list visible.");
      return true;
    }
    await pollDelay(350);
  }
  return false;
}

async function processOneTransfer(
  ctx: EnquiryTransferContext,
  detailPage: Page,
): Promise<void> {
  const { log } = ctx;

  let mainModal = await visibleEnquiryModal(detailPage);
  await mainModal.waitFor({ state: "visible", timeout: 4_000 });
  await log("info", "SALES CUSTOMER ENQUIRY INFO open — filling transfer fields (modal; list page is not edited).");

  mainModal = await ensurePinOnEnquiryModal(detailPage, log);
  await mainModal.waitFor({ state: "visible", timeout: 5_000 });

  const basicAlreadySaved = await isBasicInfoTransferFieldsFilled(mainModal);
  if (basicAlreadySaved) {
    await log(
      "info",
      "Basic Info pre-filled — round-robin Sales Consultant update, Save, then Follow Up.",
    );
  } else {
    await log(
      "info",
      "PIN step done — filling TD Offer, Reason for No, Sales Consultant on Basic Info.",
    );
  }

  await fillBasicInfoAfterPin(detailPage, ctx);

  await log(
    "info",
    basicAlreadySaved
      ? "Clicking Basic Info Save (#btnBasicSave) on pre-filled enquiry before Follow Up."
      : "Saving Basic Info tab (#btnBasicSave).",
  );
  await saveUntilSuccess(detailPage, log, ctx);

  await completeFollowUpTab(detailPage, log, ctx);
  await log("info", "Enquiry transfer cycle completed.");
}

export async function runEnquiryTransfer(ctx: EnquiryTransferContext): Promise<void> {
  const { page: listPage, sources, subSources, log } = ctx;
  await applyInputGuardToPage(listPage);
  const criteria = buildCriteria(sources, subSources);

  for (const parent of ["Digital", "CRM"] as const) {
    if (!sources.includes(parent)) continue;
    const subs = subSources?.[parent] ?? [];
    if (subs.length === 0) {
      throw new Error(`At least one sub source required for ${parent}`);
    }
  }

  const enquiryModalOpen = await isAnyEnquiryModalVisible(listPage);
  if (enquiryModalOpen) {
    await log(
      "info",
      "SALES CUSTOMER ENQUIRY INFO already open — continuing PIN / Basic Info on this screen.",
    );
  } else if (await isOnCustomerEnquiryList(listPage)) {
    await log("info", "Already on Sales Customer Enquiry list — Search all sources, then match rows.");
    await waitForCustomerEnquiryListShell(listPage, log).catch(() => {});
    await ensureLeadTabActive(listPage, log);
  } else {
    await waitForGdmsDashboardReady(listPage, log, 180_000);
    await navigateToCustomerEnquiry(listPage, log, ctx.runId);
    await log("info", "On Sales Customer Enquiry list — Search all sources, then match rows.");
  }

  await log(
    "info",
    `Polling: click Search (no source filter), pick one matching enquiry, transfer — repeat. Matching: ${formatCriteriaSummary(criteria)}.`,
  );

  while (true) {
    if (await ctx.shouldStop()) throw new Error("stopped");
    await ctx.waitIfPaused();

    if (!(await isOnCustomerEnquiryList(listPage))) {
      await navigateToCustomerEnquiry(listPage, log, ctx.runId);
    }

    if (await isAnyEnquiryModalVisible(listPage)) {
      const opened = await readEnquirySourceFieldsFromModal(listPage);
      if (opened && rowMatchesCriteria(opened.source, opened.subSource, criteria)) {
        await log(
          "info",
          `Enquiry modal open — source matches (${opened.source}${opened.subSource ? ` / ${opened.subSource}` : ""}). Continuing transfer.`,
        );
        let transferCompleted = false;
        try {
          await processOneTransfer(ctx, listPage);
          transferCompleted = true;
        } finally {
          if (transferCompleted) {
            await waitUntilEnquirySurfaceClosedAfterTransfer(ctx, listPage, listPage);
            await humanDelay(800, 1800);
            await ensureListPageForPolling(listPage, log);
          }
        }
        continue;
      }
      if (opened) {
        await log(
          "warn",
          `Enquiry modal open but source does not match (${opened.source}${opened.subSource ? ` / ${opened.subSource}` : ""}) — expected ${formatCriteriaSummary(criteria)}. Closing modal.`,
        );
      } else {
        await log(
          "warn",
          "Enquiry modal open but Enquiry Source could not be read — closing modal to search list.",
        );
      }
      await closeVisibleEnquiryModal(listPage, log);
      continue;
    }

    const matchRow = await findMatchingRowFromAllSources(listPage, criteria, log);
    if (await ctx.shouldStop()) throw new Error("stopped");
    if (!matchRow) continue;

    await log("info", "Useful enquiry found — opening SALES CUSTOMER ENQUIRY INFO (double-click row).");
    const detailPage = await openEnquiryDetailPage(matchRow);
    let transferCompleted = false;
    try {
      await processOneTransfer(ctx, detailPage);
      transferCompleted = true;
    } finally {
      if (transferCompleted) {
        await incrementRunMetric(prisma, ctx.runId, "processed").catch(() => undefined);
        await waitUntilEnquirySurfaceClosedAfterTransfer(ctx, detailPage, listPage);
        await humanDelay(800, 1800);
        await ensureListPageForPolling(listPage, log);
      }
    }
  }
}

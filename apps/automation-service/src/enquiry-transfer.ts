import type { Redis } from "ioredis";
import type { Page, Locator } from "playwright";
import type { LogLinePayload } from "@gdms/shared";
import { applyInputGuardToPage, setAutomationInputBypass } from "./automation-browser-setup.js";
import { env } from "./config.js";
import { advanceConsultantRotation, nextSalesConsultant } from "./consultant-rotation.js";
import {
  humanDelay,
  humanHoverClick,
  microDelay,
  pickRandom,
  randomBetween,
  searchIntervalDelay,
} from "./human-delay.js";
import {
  clearGdmsUiRootCache,
  clickCustomerEnquiryFlyoutMgt,
  clickCustomerEnquirySidebarIcon,
  flyoutShowsCustomerEnquiryMgt,
  isCustomerEnquiryTreeExpanded,
  isOnCustomerEnquiryList,
  isSalesFlyoutOnlyOpen,
  resolveGdmsUiRoot,
  waitForCustomerEnquiryTreeExpanded,
  waitForGdmsDashboardReady,
  type GdmsUiRoot,
} from "./gdms-session-watch.js";

export { ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE } from "./workflow-pause.js";

const PIN_CODES = ["800001", "800006", "800020", "800026"] as const;
const FOLLOW_UP_REMARKS = "Call Back...";
const SUCCESS_TOAST = /successfully reflected/i;
/** After final save, wait for CRM to dismiss enquiry UI; if stuck, re-Save up to this many times (each followed by 10–20s wait). */
const MAX_ENQUIRY_SURFACE_STUCK_RESAVES = 3;
/** Wait window for popup/modal to close on its own (ms). */
function popupCloseWaitMs(): number {
  return randomBetween(10_000, 20_000);
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
  redis: Redis;
  sources: string[];
  subSources?: Record<string, string[]>;
  log: (level: LogLinePayload["level"], message: string) => Promise<void>;
  shouldStop: () => Promise<boolean>;
  waitIfPaused: () => Promise<void>;
  /** Persist PAUSED_USER + socket event; always throws ENQUIRY_TRANSFER_PAUSED_USER_MESSAGE */
  signalManualIntervention: (message: string) => Promise<never>;
};

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GDMS labels use HMIL; tolerate legacy HMI typos in UI or saved run params. */
function gdmsLabelNorm(s: string): string {
  return norm(s).replace(/\bhmi\b/g, "hmil");
}

/** Bidirectional partial match (case-insensitive normalized). */
function partialMatch(a: string, b: string): boolean {
  const na = gdmsLabelNorm(a);
  const nb = gdmsLabelNorm(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
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

/** Selected source matches row source column OR selected sub matches row sub column (partial). */
function criterionMatchesRow(
  c: SourceCriteria,
  rowSourceCol: string,
  rowSubCol: string,
): boolean {
  const srcHit = partialMatch(c.source, rowSourceCol);
  const subHit = c.subSource ? partialMatch(c.subSource, rowSubCol) : false;
  return srcHit || subHit;
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
      await link.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
      await humanDelay(300, 700);
      try {
        await link.click({ timeout: 30_000, force: true });
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
    await link.click({ timeout: 30_000, force: true });
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
    await new Promise((r) => setTimeout(r, 500));
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
    const source = texts[cols.sourceIdx] ?? "";
    const subSource = texts[cols.subSourceIdx] ?? "";
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
  await loader.first().waitFor({ state: "hidden", timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  for (let i = 0; i < 12; i++) {
    const count = await surface.locator("table tbody tr").count();
    if (count !== prevCount || i >= 3) return count;
    await new Promise((r) => setTimeout(r, 400));
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
    await btn.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await humanDelay(300, 800);
    await btn.click({ timeout: 30_000, force: true });
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

  await log(
    "info",
    `No row matched workflow sources/sub-sources (${formatCriteriaSummary(criteria)}) — will Search again after a short wait.`,
  );
  await searchIntervalDelay();
  return null;
}

function enquiryInfoModalIn(ui: GdmsUiRoot): Locator {
  return ui.locator("[role='dialog'], .modal, .k-window").filter({
    hasText: /SALES CUSTOMER ENQUIRY INFO/i,
  });
}

function enquiryWindowWithBasicSaveIn(ui: GdmsUiRoot): Locator {
  return ui.locator(".k-window:has(#btnBasicSave), [role='dialog']:has(#btnBasicSave)");
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
    for (const factory of [enquiryWindowWithBasicSaveIn, enquiryInfoModalIn] as const) {
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

async function isAnyEnquiryModalVisible(page: Page): Promise<boolean> {
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
async function openEnquiryDetailPage(row: Locator): Promise<Page> {
  const listPage = row.page();
  const popupPromise = listPage.waitForEvent("popup", { timeout: 12_000 }).catch(() => null);
  await setAutomationInputBypass(listPage, true);
  try {
    await row.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await humanDelay(400, 900);
    await row.dblclick({ timeout: 20_000, force: true });
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
    await new Promise((r) => setTimeout(r, 400));
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
    await new Promise((r) => setTimeout(r, 400));
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
    await new Promise((r) => setTimeout(r, 350));
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
      await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
      await humanDelay(300, 700);
      await trigger.click({ timeout: 30_000, force: true });
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
    await new Promise((r) => setTimeout(r, 500));
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
    await new Promise((r) => setTimeout(r, 400));
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
  await pinInput.waitFor({ state: "visible", timeout: 15_000 });

  await withPageInputBypass(page, async () => {
    await pinInput.click();
    await pinInput.fill("");
    await pinInput.pressSequentially(pin, { delay: randomBetween(70, 200) });
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
    await log("info", "PIN already set on enquiry — skipping PIN lookup.");
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

/** Kendo DropDownList: open via span.k-select beside dt — not span.k-input (not focusable). */
async function resolveKendoDropdownTriggerNearLabel(
  formRoot: Locator,
  label: RegExp,
): Promise<Locator> {
  const dt = formRoot.locator("dt").filter({ hasText: label }).first();
  if (await dt.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const dd = dt.locator("xpath=following-sibling::dd[1]");
    for (const sel of [
      "span.k-select",
      ".k-dropdown-wrap",
      ".k-widget.k-dropdown",
      ".k-picker",
      "select",
    ] as const) {
      const trigger = dd.locator(sel).first();
      if (await trigger.isVisible({ timeout: 800 }).catch(() => false)) return trigger;
    }
    const boxForm = dt.locator("xpath=ancestor::*[contains(@class,'box_form')][1]");
    const inBox = boxForm.locator("span.k-select, .k-dropdown-wrap").first();
    if (await inBox.isVisible({ timeout: 800 }).catch(() => false)) return inBox;
  }

  const th = formRoot.locator("th").filter({ hasText: label }).first();
  if (await th.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const row = th.locator("xpath=ancestor::tr[1]");
    for (const sel of ["span.k-select", ".k-dropdown-wrap", ".k-widget.k-dropdown", ".k-picker"] as const) {
      const trigger = row.locator(sel).first();
      if (await trigger.isVisible({ timeout: 800 }).catch(() => false)) return trigger;
    }
    const td = th.locator("xpath=following-sibling::td[1]");
    for (const sel of ["span.k-select", ".k-dropdown-wrap", ".k-widget.k-dropdown", ".k-picker"] as const) {
      const trigger = td.locator(sel).first();
      if (await trigger.isVisible({ timeout: 800 }).catch(() => false)) return trigger;
    }
  }

  const labelEl = formRoot.locator("dt, th, td, label").filter({ hasText: label }).first();
  await labelEl.waitFor({ state: "visible", timeout: 12_000 });
  const section = labelEl.locator(
    "xpath=ancestor::*[contains(@class,'box_form') or self::tr or self::dl][1]",
  );
  for (const sel of ["span.k-select", ".k-dropdown-wrap", ".k-widget.k-dropdown", ".k-picker"] as const) {
    const t = section.locator(sel).first();
    if (await t.isVisible({ timeout: 800 }).catch(() => false)) return t;
  }
  const following = labelEl.locator("xpath=following::span.k-select[1] | following::.k-dropdown-wrap[1]");
  if (await following.first().isVisible({ timeout: 800 }).catch(() => false)) {
    return following.first();
  }

  throw new Error(`Kendo dropdown trigger not found for label ${String(label)}`);
}

async function openKendoDropdownNearLabel(
  modal: Locator,
  label: RegExp,
  log?: EnquiryTransferContext["log"],
): Promise<void> {
  const formRoot = await enquiryModalFormRoot(modal);
  const trigger = await resolveKendoDropdownTriggerNearLabel(formRoot, label);
  await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
  if (log) await log("info", `Opening dropdown for ${String(label)} (Kendo span.k-select).`);
  await humanHoverClick(trigger);
  await microDelay();
  await humanDelay(500, 1100);
  if (await kendoListPopupVisible(modal.page())) return;

  await trigger
    .evaluate((el) => {
      const host =
        el.closest(".k-dropdown") ??
        el.closest(".k-dropdown-wrap") ??
        el.closest("dd") ??
        el.parentElement;
      const arrow =
        host?.querySelector<HTMLElement>("span.k-select") ??
        host?.querySelector<HTMLElement>(".k-dropdown-wrap") ??
        (el as HTMLElement);
      arrow.click();
    })
    .catch(() => {});
  await humanDelay(400, 900);
  if (!(await kendoListPopupVisible(modal.page()))) {
    throw new Error(`Kendo list did not open for ${String(label)} after clicking trigger.`);
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
    await new Promise((r) => setTimeout(r, 350));
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
  const th = formRoot.locator("th").filter({ hasText: label }).first();
  if (await th.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const row = th.locator("xpath=ancestor::tr[1]");
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
    await block.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await humanDelay(400, 800);
  }
}

async function waitForEnquiryBasicInfoAfterPin(
  page: Page,
  log: EnquiryTransferContext["log"],
): Promise<Locator> {
  await log("info", "Waiting for enquiry Basic Info after PIN (not PIN search popup).");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isPinLookupPopupVisible(page)) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    let modal: Locator;
    try {
      modal = await visibleEnquiryModal(page);
    } catch {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (!(await modal.isVisible({ timeout: 500 }).catch(() => false))) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (await isPinLookupSurface(modal)) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const formRoot = await enquiryModalFormRoot(modal);
    if (
      await formRoot
        .getByText(/^TD\s*Offer/i)
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false)
    ) {
      await humanDelay(1000, 2000);
      await log("info", "Enquiry Basic Info ready — TD Offer visible (ref 10).");
      return modal;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    "Enquiry Basic Info did not appear after PIN — enquiry modal closed or still on PIN search surface.",
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
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Reason for NO did not become enabled after TD Offer: No.");
}

async function fillBasicInfoAfterPin(
  page: Page,
  log: EnquiryTransferContext["log"],
  redis: Redis,
  dealerId: string,
): Promise<Locator> {
  const modal = await waitForEnquiryBasicInfoAfterPin(page, log);
  await ensureBasicInfoTabActive(modal);
  await scrollEnquiryInfoBottomIntoView(modal);

  const tdBefore = await readDropdownDisplayNearLabel(modal, /TD\s*Offer/i);
  if (/\bno\b/i.test(tdBefore)) {
    await log("info", `TD Offer already No ("${tdBefore}") — skipping select.`);
  } else {
    await log("info", "Basic Info — TD Offer: No (ref 10).");
    await selectDropdownInFormRoot(modal, /TD\s*Offer/i, "No", log);
    const tdVal = await readDropdownDisplayNearLabel(modal, /TD\s*Offer/i);
    if (!/\bno\b/i.test(tdVal)) {
      throw new Error(`TD Offer verify failed after select (display: "${tdVal || "(empty)"}").`);
    }
    await log("info", "TD Offer set to No (verified).");
  }

  await waitForReasonForNoEnabled(modal);
  await log("info", "Reason for NO enabled — selecting random option (ref 11).");
  await selectRandomReasonForNo(modal, log);
  const reasonVal = await readDropdownDisplayNearLabel(modal, /Reason for No/i);
  if (!reasonVal.trim()) {
    throw new Error("Reason for NO verify failed — dropdown empty after select.");
  }

  const consultant = await nextSalesConsultant(redis, dealerId);
  await log("info", `Assigning sales consultant: ${consultant} (ref 12).`);
  await selectSalesConsultant(modal, consultant);
  await log("info", `Sales consultant selected: ${consultant}.`);
  return modal;
}

async function resolveSaveButton(modal: Locator, preferFinal: boolean): Promise<Locator> {
  if (preferFinal) {
    const finalId = modal.locator("#btnFinalSave").first();
    if (await finalId.isVisible({ timeout: 2_000 }).catch(() => false)) return finalId;
    const saves = modal.getByRole("button", { name: /^(final\s+)?save$/i });
    const count = await saves.count();
    for (let i = 0; i < count; i++) {
      const btn = saves.nth(i);
      const name = (await btn.innerText().catch(() => "")).toLowerCase();
      if (name.includes("final")) return btn;
    }
    if (count > 0) return saves.last();
  } else {
    const basicSave = modal.locator("#btnBasicSave").first();
    if (await basicSave.isVisible({ timeout: 2_000 }).catch(() => false)) return basicSave;
  }
  const fallback = modal.getByRole("button", { name: preferFinal ? /final\s+save/i : /^save$/i }).first();
  if ((await fallback.count()) > 0) return fallback;
  throw new Error(
    preferFinal
      ? "Final Save button not found on enquiry modal"
      : "Basic Info Save (#btnBasicSave) not found on enquiry modal",
  );
}

async function clickVisibleSaveInModal(
  page: Page,
  log: EnquiryTransferContext["log"],
  preferFinal = false,
): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  await modal.waitFor({ state: "visible", timeout: 15_000 });
  if (preferFinal) {
    await log("info", "Clicking Follow Up Final Save on enquiry modal.");
  } else {
    await log("info", "Clicking Basic Info Save (#btnBasicSave).");
  }
  const target = await resolveSaveButton(modal, preferFinal);
  await humanHoverClick(target);
}

async function saveUntilSuccess(
  page: Page,
  log: EnquiryTransferContext["log"],
  ctx: EnquiryTransferContext,
  preferFinalSave = false,
): Promise<void> {
  for (let attempt = 1; attempt <= env.GDMS_SAVE_MAX_ATTEMPTS; attempt++) {
    const modal = await visibleEnquiryModal(page);
    await withModalInputBypass(modal, async () => {
      await clickVisibleSaveInModal(page, log, preferFinalSave);
    });
    await humanDelay(
      env.GDMS_SAVE_RETRY_INTERVAL_MS,
      env.GDMS_SAVE_RETRY_INTERVAL_MS + randomBetween(800, 2800),
    );
    const toast = page.getByText(SUCCESS_TOAST);
    if (await toast.isVisible().catch(() => false)) {
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

function nextFollowUpDateIst(): { day: number; month: number; year: number } {
  const { day, month, year, hour } = istDateParts(new Date());
  const addDays = hour >= 14 ? 1 : 0;
  return addIstCalendarDays(year, month, day, addDays);
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

async function setNextFollowUpTime(page: Page): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  const target = nextFollowUpDateIst();
  const field = formRoot.getByText(/Next Follow Up Time/i).first();
  await humanHoverClick(field.locator("..").locator("button, [class*='calendar'], img").last());
  await humanDelay();

  let picker: Locator | null = null;
  for (const ui of listUiContexts(page)) {
    const candidate = ui
      .locator(
        ".k-animation-container .k-calendar, .k-datetimepicker-popup, .k-popup:has(.k-calendar), [class*='calendar']:visible, .k-calendar, [role='dialog']:has(.k-calendar)",
      )
      .last();
    if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
      picker = candidate;
      break;
    }
  }
  if (!picker) {
    picker = page
      .locator(
        ".k-animation-container .k-calendar, .k-datetimepicker-popup, .k-popup:has(.k-calendar), [class*='calendar']:visible, .k-calendar",
      )
      .last();
  }
  await picker.waitFor({ state: "visible", timeout: 15_000 });

  await navigateCalendarToDate(picker, target);

  const dayCell = picker
    .locator("td:not(.k-other-month):not(.k-state-disabled), [role='gridcell']:not([aria-disabled='true'])")
    .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
    .first();
  await dayCell.click({ timeout: 10_000 });
  await humanDelay();

  await picker.getByText(/9:30\s*PM/i).first().click({ timeout: 10_000 });
  await humanDelay();
}

async function completeFollowUpTab(page: Page, log: EnquiryTransferContext["log"], ctx: EnquiryTransferContext): Promise<void> {
  const modal = await visibleEnquiryModal(page);
  const formRoot = await enquiryModalFormRoot(modal);
  await log("info", "Follow Up tab — remarks, Phone, Verification Y, 9:30 PM IST, Cold.");
  await humanHoverClick(formRoot.getByText(/^Follow Up$/i));
  await humanDelay();

  const remarks = formRoot
    .getByLabel(/Follow Up Remarks/i)
    .or(formRoot.locator("textarea").first());
  await remarks.click();
  await remarks.fill("");
  await remarks.pressSequentially(FOLLOW_UP_REMARKS, { delay: randomBetween(55, 160) });
  await humanDelay();

  await selectDropdownNearLabel(modal, /Next Follow Up Type/i, /^Phone$/i);
  await selectMandatoryVerificationY(modal);
  await setNextFollowUpTime(page);
  await selectDropdownNearLabel(modal, /Enquiry Type/i, /^Cold$/i);

  await log("info", "Saving Follow Up tab (Final Save on enquiry modal).");
  await saveUntilSuccess(page, log, ctx, true);
}

async function processOneTransfer(
  ctx: EnquiryTransferContext,
  detailPage: Page,
): Promise<void> {
  const { log, redis, dealerId } = ctx;

  let mainModal = await visibleEnquiryModal(detailPage);
  await mainModal.waitFor({ state: "visible", timeout: 45_000 });
  await log("info", "SALES CUSTOMER ENQUIRY INFO open — filling transfer fields (modal; list page is not edited).");

  mainModal = await ensurePinOnEnquiryModal(detailPage, log);
  await mainModal.waitFor({ state: "visible", timeout: 15_000 });

  await fillBasicInfoAfterPin(detailPage, log, redis, dealerId);

  await log("info", "Saving Basic Info tab (#btnBasicSave).");
  await saveUntilSuccess(detailPage, log, ctx);

  await completeFollowUpTab(detailPage, log, ctx);
  await advanceConsultantRotation(redis, dealerId);
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
      await log(
        "info",
        "Enquiry modal already open — continuing transfer from PIN / Basic Info (no double-click).",
      );
      let transferCompleted = false;
      try {
        await processOneTransfer(ctx, listPage);
        transferCompleted = true;
      } finally {
        if (transferCompleted) {
          await waitUntilEnquirySurfaceClosedAfterTransfer(ctx, listPage, listPage);
        }
        await humanDelay(800, 1800);
        await ensureListPageForPolling(listPage, log);
      }
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
        await waitUntilEnquirySurfaceClosedAfterTransfer(ctx, detailPage, listPage);
      }
      await humanDelay(800, 1800);
      await ensureListPageForPolling(listPage, log);
    }
  }
}

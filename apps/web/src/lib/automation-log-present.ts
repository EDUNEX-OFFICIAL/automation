/**
 * Map raw automation log lines to a short phase + operator hint for the Live session UI.
 * (GDMS UI often uses * as mandatory marker — not the word "Star".)
 */

export type AutomationLogCategory =
  | "login"
  | "navigation"
  | "search"
  | "match"
  | "pin"
  | "form"
  | "save"
  | "follow-up"
  | "session"
  | "system"
  | "other";

export type ParsedAutomationLog = {
  category: AutomationLogCategory;
  /** Short badge text for the log row */
  badge: string;
  /** Extra context when the message alone is opaque */
  hint?: string;
};

type Rule = {
  match: (m: string) => boolean;
  out: ParsedAutomationLog;
};

const rules: Rule[] = [
  {
    match: (m) =>
      m.includes("playwright_headed") ||
      m.includes("enquiry transfer requires") ||
      m.includes("visible browser only"),
    out: {
      category: "session",
      badge: "CONFIG",
      hint: "Automation service env: enquiry transfer needs a headed/visible browser on the host.",
    },
  },
  {
    match: (m) => m.includes("workflow failed:") || m.startsWith("error:"),
    out: {
      category: "system",
      badge: "ERROR",
      hint: "See the Chromium window — timeout, selector miss, or CRM blocked the action.",
    },
  },
  {
    match: (m) => m.includes("manual intervention") || m.includes("paused for manual"),
    out: {
      category: "system",
      badge: "PAUSE",
      hint: "Fix the form in the visible GDMS window, then use Retry transfer.",
    },
  },
  {
    match: (m) => m.includes("pin search returned no rows"),
    out: {
      category: "pin",
      badge: "PIN",
      hint: "PIN lookup modal: no row for chosen pin — network or CRM data issue.",
    },
  },
  {
    match: (m) => m.includes("could not select mandatory verification"),
    out: {
      category: "follow-up",
      badge: "F/U",
      hint: "Follow-up tab: field is usually labeled '* Verification' (* = mandatory), not the word Star.",
    },
  },
  {
    match: (m) => m.includes("could not find customer enquiry") || m.includes("car sidebar"),
    out: {
      category: "navigation",
      badge: "NAV",
      hint: "Sidebar CAR/menu opens Customer Enquiry — UI layout may need GDMS_SEL_CAR_SIDEBAR override.",
    },
  },
  {
    match: (m) => m.includes("could not select sales consultant"),
    out: {
      category: "form",
      badge: "FORM",
      hint: "Sales Consultant dropdown — spelling/locator mismatch vs CRM list.",
    },
  },
  {
    match: (m) => m.includes("opening customer enquiry"),
    out: {
      category: "navigation",
      badge: "NAV",
      hint: "Opening Customer Enquiry list (sidebar → menu).",
    },
  },
  {
    match: (m) => m.includes("back on enquiry list") || m.includes("resuming search polling"),
    out: {
      category: "search",
      badge: "POLL",
      hint: "Between transfers: back on grid, next Search soon.",
    },
  },
  {
    match: (m) =>
      m.includes("action bar") ||
      m.includes("not global header") ||
      m.includes("all sources") ||
      m.includes("no source filter") ||
      m.includes("search all sources"),
    out: {
      category: "search",
      badge: "SEARCH",
      hint: "Page action bar Search (next to Allocate / + New), not the blue header — all sources in the table.",
    },
  },
  {
    match: (m) =>
      m.includes("no row matched workflow") ||
      m.includes("will search again after a short wait"),
    out: {
      category: "search",
      badge: "POLL",
      hint: "No useful enquiry this cycle — waits, then clicks Search again for new rows.",
    },
  },
  {
    match: (m) => m.includes("polling: click search"),
    out: {
      category: "search",
      badge: "LIST",
      hint: "Infinite poll: Search → pick matching row → one transfer → repeat.",
    },
  },
  {
    match: (m) => m.includes("search returned") && m.includes("row"),
    out: {
      category: "search",
      badge: "SEARCH",
      hint: "Just ran Search — rows are matched from table Enquiry Source / Sub Source columns.",
    },
  },
  {
    match: (m) => m.includes("filling transfer fields") || m.includes("starting * pin flow"),
    out: {
      category: "form",
      badge: "MODAL",
      hint: "Enquiry detail modal (image 7+): PIN, TD Offer, consultant, Follow Up — not the list filters.",
    },
  },
  {
    match: (m) =>
      m.includes("opening * pin lookup") ||
      m.includes("clicked pin lookup") ||
      m.includes("magnifier beside"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "Click magnifier beside #pin (not the disabled field) to open PIN lookup popup.",
    },
  },
  {
    match: (m) =>
      m.includes("typing") &&
      m.includes("pin code filter") &&
      !m.includes("did not accept"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "Entering PIN in PIN Code filter (keyboard bypass on) — then Search.",
    },
  },
  {
    match: (m) =>
      m.includes("pin code filter shows") ||
      (m.includes("entered") && m.includes("pin code")),
    out: {
      category: "form",
      badge: "PIN",
      hint: "PIN Code filter filled — Search runs next, then pick a row and Add Selected.",
    },
  },
  {
    match: (m) =>
      m.includes("pin code filter did not accept") ||
      (m.includes("did not accept") && m.includes("pin code")),
    out: {
      category: "form",
      badge: "PIN",
      hint: "PIN did not stick in filter — check PIN Code column (not Post Office Name).",
    },
  },
  {
    match: (m) =>
      m.includes("post office row(s) already visible") ||
      m.includes("pin lookup popup already open"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "PIN results on screen — automation picks a row and Add Selected next (ref 9).",
    },
  },
  {
    match: (m) =>
      m.includes("single-clicked post office row") ||
      m.includes("selected row — clicking add selected"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "Pick one post office row in PIN popup, then Add Selected (ref image 9).",
    },
  },
  {
    match: (m) =>
      m.includes("clicked add selected") ||
      m.includes("pin lookup popup closed"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "Add Selected applied — popup closes, main enquiry PIN fills; then TD Offer / Save.",
    },
  },
  {
    match: (m) => m.includes("pin popup:") || m.includes("pin lookup popup did not open"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "In popup: type in PIN Code field (not Post Office Name) → Search → one row → Add Selected.",
    },
  },
  {
    match: (m) => m.includes("cleared misplaced pin") || m.includes("post office name field"),
    out: {
      category: "form",
      badge: "PIN",
      hint: "Wrong field had PIN digits — cleared Post Office Name; should use PIN Code.",
    },
  },
  {
    match: (m) =>
      m.includes("waiting for enquiry basic info after pin") ||
      m.includes("enquiry basic info ready"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "PIN done — filling TD Offer, Reason for NO, Sales Consultant on enquiry modal.",
    },
  },
  {
    match: (m) =>
      m.includes("td offer verify failed") ||
      m.includes("basic info did not appear after pin"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "TD Offer / Basic Info failed — enquiry modal may have closed; check Live preview.",
    },
  },
  {
    match: (m) => m.includes("td offer set to no") && m.includes("verified"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "TD Offer is No — Reason for NO and consultant next, then Basic Save.",
    },
  },
  {
    match: (m) => m.includes("pin already set on enquiry"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "PIN filled — next: TD Offer No, Reason for NO, Sales Consultant (refs 10–12).",
    },
  },
  {
    match: (m) => m.includes("basic info") && m.includes("td offer"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "Setting TD Offer to No (ref 10) — Reason for NO unlocks after this.",
    },
  },
  {
    match: (m) => m.includes("td offer set to no"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "TD Offer is No — picking a random Reason for NO (ref 11).",
    },
  },
  {
    match: (m) => m.includes("reason for no enabled") || m.includes("reason for no selected"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "Reason for NO done — assigning Sales Consultant in rotation (ref 12).",
    },
  },
  {
    match: (m) =>
      m.includes("assigning sales consultant") || m.includes("sales consultant selected"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "Consultant chosen — Basic Info Save until success toast (ref 13).",
    },
  },
  {
    match: (m) => m.includes("enquiry modal already open"),
    out: {
      category: "form",
      badge: "MODAL",
      hint: "Modal was open — continues PIN / Basic Info without double-clicking the list row.",
    },
  },
  {
    match: (m) => m.includes("pin added") || m.includes("td offer: no"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "Basic Info tab: TD Offer No, Reason for No, then Sales Consultant.",
    },
  },
  {
    match: (m) => m.includes("assigning sales consultant"),
    out: {
      category: "form",
      badge: "BASIC",
      hint: "Rotating consultant on Basic Info before Save.",
    },
  },
  {
    match: (m) => m.includes("clicking basic info save") || m.includes("#btnbasicsave"),
    out: {
      category: "save",
      badge: "SAVE",
      hint: "Basic Info Save (#btnBasicSave) — waits for success toast.",
    },
  },
  {
    match: (m) => m.includes("follow up tab") || m.includes("clicking follow up final save"),
    out: {
      category: "form",
      badge: "FOLLOW",
      hint: "Follow Up tab: Phone, Verification Y, 9:30 PM, Cold — then Final Save.",
    },
  },
  {
    match: (m) => m.includes("enquiry transfer cycle completed"),
    out: {
      category: "form",
      badge: "DONE",
      hint: "One enquiry transferred — modal should close, then Search polls again.",
    },
  },
  {
    match: (m) => m.includes("reason for no selected"),
    out: {
      category: "form",
      badge: "FORM",
      hint: "Reason for NO dropdown on Basic Info tab (image 11).",
    },
  },
  {
    match: (m) => m.includes("activated lead tab"),
    out: {
      category: "search",
      badge: "LIST",
      hint: "Lead sub-tab selected before Search (image 4).",
    },
  },
  {
    match: (m) => m.includes("matched enquiry"),
    out: {
      category: "match",
      badge: "MATCH",
      hint: "Double-clicking row to open enquiry detail (new window or modal).",
    },
  },
  {
    match: (m) =>
      m.includes("waiting for enquiry modal to close") ||
      m.includes("waiting for enquiry popup window to close"),
    out: {
      category: "form",
      badge: "DISMISS",
      hint: "After save CRM should close the window — we wait (no manual close), then optional re-Save if stuck.",
    },
  },
  {
    match: (m) =>
      m.includes("clicking save again") &&
      (m.includes("enquiry modal still visible") || m.includes("popup still open")),
    out: {
      category: "save",
      badge: "RE-SAVE",
      hint: "Modal/popup did not auto-close within 10–20s — nudging CRM with Save again (max 3 tries).",
    },
  },
  {
    match: (m) => m.includes("re-save to close:"),
    out: {
      category: "save",
      badge: "RE-SAVE",
      hint: "Save button missing on stuck modal — check visible GDMS window.",
    },
  },
  {
    match: (m) =>
      m.includes("enquiry modal closed") ||
      m.includes("enquiry popup closed") ||
      m.includes("enquiry popup closed after re-save") ||
      m.includes("enquiry modal closed after re-save"),
    out: {
      category: "form",
      badge: "OK",
      hint: "Enquiry UI dismissed — back to list polling.",
    },
  },
  {
    match: (m) =>
      m.includes("modal did not close after repeated") || m.includes("popup did not close after waits"),
    out: {
      category: "system",
      badge: "STUCK",
      hint: "PAUSED_USER — close stuck window in GDMS or fix CRM, then Retry transfer.",
    },
  },
  {
    match: (m) => m.includes("save attempt") || m.includes("waiting for success toast"),
    out: {
      category: "save",
      badge: "SAVE",
      hint: "Watch the real GDMS window: success is a green toast (often bottom-right).",
    },
  },
  {
    match: (m) => m.includes("save succeeded"),
    out: { category: "save", badge: "SAVE OK", hint: "CRM accepted this save." },
  },
  {
    match: (m) => m.includes("saving basic info"),
    out: {
      category: "form",
      badge: "FORM",
      hint: "Main enquiry modal: TD offer, consultant, etc.",
    },
  },
  {
    match: (m) => m.includes("assigning sales consultant"),
    out: {
      category: "form",
      badge: "CONSULT",
      hint: "Round-robin consultant field on GDMS.",
    },
  },
  {
    match: (m) => m.includes("saving follow up") || m.includes("follow up tab"),
    out: {
      category: "follow-up",
      badge: "F/U",
      hint: "Follow-up tab: remarks, phone, mandatory * Verification, calendar.",
    },
  },
  {
    match: (m) => m.includes("enquiry transfer cycle completed"),
    out: {
      category: "other",
      badge: "CYCLE",
      hint: "One transfer done; polling the list again.",
    },
  },
  {
    match: (m) => m.includes("search window expired"),
    out: {
      category: "search",
      badge: "TIMEOUT",
      hint: "GDMS_ENQUIRY_SEARCH_TIMEOUT_MS capped the search window (0 = unlimited).",
    },
  },
  {
    match: (m) => m.includes("starting enquiry transfer"),
    out: {
      category: "search",
      badge: "START",
      hint: "Daemon loop: search until Stop, one enquiry at a time.",
    },
  },
  {
    match: (m) => m.includes("gdms dashboard") || m.includes("dashboard is ready"),
    out: {
      category: "login",
      badge: "DASH",
      hint: "Login/OTP phase or post-login readiness.",
    },
  },
  {
    match: (m) => m.includes("session active") && m.includes("skipping login"),
    out: {
      category: "login",
      badge: "SESSION",
      hint: "Reused browser profile — login steps skipped.",
    },
  },
  {
    match: (m) => m.includes("completed step"),
    out: {
      category: "login",
      badge: "STEP",
      hint: "Workflow engine step finished (often login chain).",
    },
  },
  {
    match: (m) => m.includes("retrying enquiry transfer"),
    out: {
      category: "system",
      badge: "RETRY",
      hint: "Continuing on the kept-open browser session.",
    },
  },
];

export function parseAutomationLogLine(message: string): ParsedAutomationLog {
  const m = message.trim().toLowerCase();
  for (const r of rules) {
    if (r.match(m)) return r.out;
  }
  return { category: "other", badge: "LOG" };
}

export function formatLogTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

/**
 * Short operator-facing text for Live session Activity log.
 */

const MAX_LEN = 72;

const REPLACEMENTS: { match: RegExp; text: string }[] = [
  { match: /^Run queued again\.?$/i, text: "Sent back to queue." },
  { match: /^Control confirmed: (\w+)$/i, text: "$1 accepted." },
  { match: /^Control \((\w+)\) failed:/i, text: "Could not $1:" },
  { match: /^Workflow failed:/i, text: "Stopped:" },
  { match: /^Paused for manual intervention:/i, text: "Paused — fix GDMS, then Resume." },
  { match: /^Paused — fix anything in GDMS/i, text: "Paused." },
  { match: /^Resumed — automation continues/i, text: "Resumed." },
  { match: /^Stopped — you can start/i, text: "Stopped." },
  {
    match: /clicking page search|action bar.*not global|all sources.*filter unchanged/i,
    text: "Searching list…",
  },
  {
    match: /search returned 0 useful|table empty|no-data placeholder|no enquiry source text in rows/i,
    text: "No match — trying again soon.",
  },
  {
    match: /search returned \d+ useful row/i,
    text: "List updated — checking rows…",
  },
  {
    match: /no row matched workflow|sample rows:/i,
    text: "No match for your sources — retrying.",
  },
  {
    match: /matched enquiry|useful enquiry found/i,
    text: "Match found — opening enquiry.",
  },
  { match: /polling: click search/i, text: "Watching enquiry list…" },
  { match: /gdms dashboard is ready|home screen detected/i, text: "GDMS ready." },
  { match: /session active.*skipping login/i, text: "Using saved login." },
  {
    match: /missing x server|xserver running|xvfb display .* not ready/i,
    text: "Display starting — wait a few seconds, then Start again.",
  },
  {
    match: /executable doesn't exist|playwright install chromium/i,
    text: "Browser not installed on server.",
  },
  {
    match: /saved gdms login token expired.*automated login/i,
    text: "Token expired — logging in automatically.",
  },
  {
    match: /saved gdms login token did not restore|opening login page for automated login/i,
    text: "Opening GDMS login page…",
  },
  {
    match: /gdms session redirect script detected/i,
    text: "Opening GDMS login page…",
  },
  {
    match: /JSON at position|gdms_bootstrap|bootstrap cookies/i,
    text: "Login expired — update token on Dashboard.",
  },
  { match: /profile appears to be in use/i, text: "Browser busy — retrying." },
  { match: /live updates disconnected/i, text: "Live link lost — run may continue." },
  { match: /^error:/i, text: "" },
  { match: /bootstrap cookies applied/i, text: "Saved login applied." },
  { match: /browser input locked/i, text: "GDMS locked — use Pause or Stop here." },
  { match: /continue transfer acknowledged/i, text: "Continuing from current screen." },
  { match: /open enquiry modal detected/i, text: "Resuming on open enquiry." },
  { match: /restart(ing)? enquiry transfer on the active browser session/i, text: "Retrying transfer." },
  { match: /resuming paused enquiry transfer/i, text: "Resuming transfer on open browser." },
  { match: /open enquiry modal — resuming follow up/i, text: "Continuing Follow Up on open enquiry." },
  { match: /waiting for gdms dashboard|still waiting for dashboard/i, text: "Waiting for GDMS home." },
  { match: /otp step pending|still on login url/i, text: "Waiting for OTP." },
  { match: /paused from live session/i, text: "Paused here." },
  { match: /stopped from live session/i, text: "Stopped here." },
  { match: /pause confirmed|resume confirmed|stop confirmed/i, text: "OK." },
  { match: /follow up list loading|follow up list settled|list still loading|gdms still loading|not marking run complete/i, text: "Waiting for GDMS list…" },
  { match: /lost inquiry finished — list loaded/i, text: "Lost Inquiry done — list clear." },
  { match: /lost inquiry complete|starting lost inquiry/i, text: "Lost Inquiry run." },
  { match: /lost inquiry — process|lost inquiry — \d+ matching/i, text: "Lost Inquiry — scanning list…" },
  { match: /no rows with last follow-up remarks starting with lost/i, text: "No Lost rows on this list." },
  { match: /ollama surveillance on/i, text: "AI recovery enabled." },
  { match: /calendar date picked/i, text: "Due date filter set." },
  { match: /car sidebar \(booking path\)/i, text: "Sidebar — Booking/Retail path." },
  { match: /setting follow-up due date to = upcoming sunday/i, text: "Filtering due date → Sunday." },
  { match: /follow-up due date to already|follow-up due date to =/i, text: "Due date filter…" },
  { match: /opening today's follow up|today's follow up in menu tree|booking\/retail mgt/i, text: "Opening Today's Follow Up…" },
  { match: /step \d+\/\d+.*today|step \d+\/\d+.*booking|step \d+\/\d+: click sales car/i, text: "Opening Today's Follow Up…" },
  { match: /lost inquiry — switching to basic info|cancelation info|lost enquiry/i, text: "Lost Inquiry — closing enquiry." },
  { match: /step \d+\/\d+|step 1–2\/3/i, text: "Opening Customer Enquiry…" },
  { match: /opening customer enquiry|customer enquiry mgt|nav_sal|flyout/i, text: "Opening Customer Enquiry…" },
  { match: /back on enquiry list|resuming search polling/i, text: "Back to list." },
  { match: /activated lead tab|lead tab selected/i, text: "Lead tab on." },
  { match: /filling transfer fields|starting \* pin flow/i, text: "Filling enquiry form." },
  { match: /pin popup:|pin lookup|magnifier beside|opening \* pin/i, text: "PIN lookup…" },
  { match: /add selected|pin lookup popup closed|pin selected/i, text: "PIN done." },
  { match: /td offer|reason for no|basic info/i, text: "Basic info…" },
  { match: /assigning sales consultant|sales consultant selected/i, text: "Consultant assigned." },
  { match: /clicking basic info save|#btnbasicsave/i, text: "Saving basic info." },
  { match: /opened date picker \(calendar icon\)|opening calendar\./i, text: "Calendar icon clicked — picker opening…" },
  { match: /icon not found.*k-i-calendar/i, text: "Calendar icon not found on form." },
  { match: /opening calendar\/clock picker|always before save/i, text: "Opening date & time picker…" },
  { match: /picker attempt \d+\/3 failed|trigger not found|icon not found/i, text: "Calendar icon click failed — retrying…" },
  { match: /follow up tab — opening for remarks/i, text: "On Follow Up tab." },
  { match: /follow up tab lost — re-clicking/i, text: "Follow Up tab re-selected." },
  { match: /follow up tab — fill missing fields/i, text: "Filling follow-up form…" },
  { match: /follow up remarks already set|follow up remarks set to/i, text: "Follow-up remark saved." },
  { match: /follow up type already phone/i, text: "Follow-up type — Phone." },
  { match: /next follow up type already phone/i, text: "Next type — Phone." },
  { match: /next follow up time already set|skipping calendar/i, text: "Next time already set." },
  { match: /enquiry type already cold/i, text: "Enquiry Type already Cold." },
  { match: /enquiry type = cold/i, text: "Enquiry Type — Cold." },
  { match: /follow up already filled/i, text: "Follow-up ready — Cold + Save." },
  { match: /opening dropdown for/i, text: "" },
  { match: /follow up tab — filling remarks/i, text: "Filling follow-up form…" },
  { match: /calendar retry \(2nd attempt\)/i, text: "Calendar retry — 2nd attempt…" },
  { match: /Next Follow Up \(transfer\)|Next Follow Up \(skip/i, text: "Setting next follow-up date & time…" },
  { match: /opened date picker|opened time list|single click (calendar|clock) icon/i, text: "Opening date & time picker…" },
  { match: /single-click date \d/i, text: "Picker open — picking date…" },
  { match: /select 21:30|selected 9:30 pm|scrolling time list/i, text: "Picker open — picking 21:30…" },
  { match: /Follow Up Skip form complete|ready for Save/i, text: "Form ready — saving follow-up." },
  { match: /Follow Up Save blocked|not ready for Save/i, text: "Save blocked — form incomplete." },
  { match: /single click (calendar|clock) icon|date\+time picker \(no typing/i, text: "Opening date & time picker (single click)…" },
  { match: /calendar \+ time picker|combined calendar|21:30 from time column/i, text: "Picker open — picking date & 21:30…" },
  { match: /next follow up time set:|selected 9:30 pm \(single click\)|timeselector columns|field filled after picker/i, text: "Next follow-up time set." },
  { match: /Follow Up Skip — Next Follow Up Type|Next Follow Up Type.*type P/i, text: "Next Follow Up Type — open, type P, Enter." },
  { match: /Follow Up Skip — Follow Up Type|Follow Up Type.*type P/i, text: "Follow Up Type — open, type P, Enter." },
  { match: /Next Follow Up Type = Phone|Follow Up Type = Phone/i, text: "Type set to Phone." },
  { match: /next follow up time still empty|could not be set after/i, text: "Next follow-up time failed — check calendar." },
  { match: /follow up save|btnfollowupsave|clicking follow up save/i, text: "Saving follow-up." },
  { match: /enquiry transfer cycle completed/i, text: "One done — next search." },
  { match: /enquiry modal closed|popup closed/i, text: "Window closed." },
  { match: /modal did not close|popup did not close/i, text: "Window stuck — check GDMS." },
  { match: /save succeeded|success toast/i, text: "Saved." },
  { match: /starting enquiry transfer/i, text: "Transfer started." },
  { match: /on sales customer enquiry list/i, text: "On enquiry list." },
  { match: /today's follow up|follow-up \d+\/\d+/i, text: "Follow-up list…" },
  { match: /gdms logout requested/i, text: "Sign-out requested." },
  { match: /completed step/i, text: "Login step done." },
  { match: /enter otp into gdms/i, text: "OTP submitted." },
  { match: /already on sales customer enquiry/i, text: "Already on enquiry list." },
  { match: /crm shows no data/i, text: "List empty — retrying." },
  { match: /will search again/i, text: "No match — trying again soon." },
  { match: /looking for:/i, text: "Checking rows…" },
  { match: /tbody tr|rawbodycount/i, text: "No match — trying again soon." },
];

function stripTechnicalNoise(text: string): string {
  return text
    .replace(/#[\w-]+/g, "")
    .replace(/\bli\.nav_sal\b/gi, "")
    .replace(/\bDOM\b/g, "")
    .replace(/\bPlaywright\b/gi, "")
    .replace(/\bjQuery\b/gi, "")
    .replace(/\bk-window\b/gi, "")
    .replace(/\btbody\s*tr\b/gi, "")
    .replace(/\bref(s)?\s+\d+/gi, "")
    .replace(/\([^)]{40,}\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function shortenFallback(cleaned: string): string {
  const lower = cleaned.toLowerCase();
  if (/search returned 0|table empty|no useful row|no row matched|no-data placeholder/.test(lower)) {
    return "No match — trying again soon.";
  }
  if (/clicking page search|click search|search returned/.test(lower)) return "Searching list…";
  if (/matched enquiry|useful enquiry|double-click/.test(lower)) return "Opening enquiry…";
  if (/pin popup|pin lookup|pin code filter/.test(lower)) return "PIN lookup…";
  if (/enquiry tab activated|follow-up tab opened|opening date & time picker/i.test(lower)) {
    return "Opening date & time picker…";
  }
  if (/follow up remarks|follow-up remark saved/i.test(lower)) return "Follow-up remark saved.";
  if (/follow up type already phone|follow-up type — phone/i.test(lower)) return "Follow-up type — Phone.";
  if (/next follow up type already phone|next type — phone/i.test(lower)) return "Next type — Phone.";
  if (/next follow up time already set|next time already set/i.test(lower)) return "Next time already set.";
  if (/enquiry type already cold|enquiry type — cold/i.test(lower)) return "Enquiry Type — Cold.";
  if (/follow up tab — opening|on follow up tab/i.test(lower)) return "On Follow Up tab.";
  if (/follow up tab lost|follow up tab re-selected/i.test(lower)) return "Follow Up tab re-selected.";
  if (/follow up tab — fill missing|filling follow-up form/i.test(lower)) return "Filling follow-up form…";
  if (/opening dropdown for/i.test(lower)) return "";
  if (/lost inquiry|last follow-up remarks|follow-up due date|ollama surveillance|cancelation info/i.test(lower)) {
    if (/lost inquiry finished|no lost rows remain|lost inquiry complete/i.test(lower)) {
      return "Lost Inquiry done.";
    }
    if (/no rows with last follow-up remarks/i.test(lower)) return "No Lost rows on list.";
    if (/ollama surveillance on/i.test(lower)) return "AI recovery enabled.";
    if (/calendar date picked|due date/i.test(lower)) return "Due date filter set.";
    return "Lost Inquiry step…";
  }
  if (/opening today's follow up|booking\/retail|today's follow up list/i.test(lower)) {
    return "Opening Today's Follow Up…";
  }
  if (/follow up|follow-up/.test(lower)) return "Follow-up step…";
  if (/basic info|td offer|consultant/.test(lower)) return "Filling form…";
  if (/save|toast/.test(lower)) return "Saving…";
  if (/otp|login url|signing in|opening gdms login/i.test(lower)) return "Signing in…";
  if (/closing browser|marking run finished|workflow completed/i.test(lower)) return "Run finished.";
  if (/paused|pause/.test(lower)) return "Paused.";
  if (/stopped|stop/.test(lower)) return "Stopped.";
  if (/\bfailed\b|\berror\b/i.test(cleaned) && !/surveillance|reason for failure|reason failure/i.test(lower)) {
    return "Problem — check GDMS window.";
  }
  if (cleaned.length > MAX_LEN) return `${cleaned.slice(0, MAX_LEN - 1)}…`;
  return cleaned;
}

export function userFacingLogMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  for (const { match, text } of REPLACEMENTS) {
    const m = trimmed.match(match);
    if (m) {
      if (text === "" && /^error:/i.test(trimmed)) {
        return shortenFallback(stripTechnicalNoise(trimmed.replace(/^error:\s*/i, "")));
      }
      if (m[1] && text.includes("$1")) return text.replace("$1", m[1].toLowerCase());
      return text;
    }
  }

  return shortenFallback(stripTechnicalNoise(trimmed));
}

export function runStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "PENDING":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "PAUSED_OTP":
      return "Waiting for OTP";
    case "PAUSED_USER":
      return "Paused";
    case "FAILED":
      return "Failed";
    case "STOPPED":
      return "Stopped";
    case "COMPLETED":
      return "Completed";
    default:
      return status?.replace(/_/g, " ") ?? "—";
  }
}

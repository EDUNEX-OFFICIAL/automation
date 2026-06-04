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
    match: /executable doesn't exist|playwright install chromium/i,
    text: "Browser not installed on server.",
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
  { match: /resuming enquiry transfer|resuming from saved browser/i, text: "Continuing transfer." },
  { match: /restart(ing)? enquiry transfer|retry transfer/i, text: "Retrying transfer." },
  { match: /waiting for gdms dashboard|still waiting for dashboard/i, text: "Waiting for GDMS home." },
  { match: /otp step pending|still on login url/i, text: "Waiting for OTP." },
  { match: /paused from live session/i, text: "Paused here." },
  { match: /stopped from live session/i, text: "Stopped here." },
  { match: /pause confirmed|resume confirmed|stop confirmed/i, text: "OK." },
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
  { match: /follow up remarks set to|follow up remarks =/i, text: "Follow-up remark saved." },
  { match: /follow up tab|follow up save|follow up final/i, text: "Saving follow-up." },
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
  if (/follow up remarks/.test(lower)) return "Follow-up remark saved.";
  if (/follow up|follow-up/.test(lower)) return "Follow-up step…";
  if (/basic info|td offer|consultant/.test(lower)) return "Filling form…";
  if (/save|toast/.test(lower)) return "Saving…";
  if (/otp|login|dashboard/.test(lower)) return "Signing in…";
  if (/paused|pause/.test(lower)) return "Paused.";
  if (/stopped|stop/.test(lower)) return "Stopped.";
  if (/error|failed/.test(lower)) return "Problem — check GDMS window.";
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

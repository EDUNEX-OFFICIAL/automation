/**
 * Short, operator-facing text for Live session log lines (raw message kept for copy).
 */

const REPLACEMENTS: { match: RegExp; text: string }[] = [
  { match: /^Run queued again\.?$/i, text: "Run sent back to the automation queue." },
  { match: /^Control confirmed: (\w+)$/i, text: "Server confirmed your $1 command." },
  { match: /^Control \((\w+)\) failed:/i, text: "Could not $1 the run:" },
  { match: /^Workflow failed:/i, text: "Automation stopped because:" },
  { match: /^Paused for manual intervention:/i, text: "Paused — action needed in GDMS:" },
  { match: /polling: click search/i, text: "Refreshing the enquiry list (Search)…" },
  { match: /no row matched workflow/i, text: "No enquiry matched your selected sources — will search again shortly." },
  { match: /matched enquiry/i, text: "Found a matching enquiry — opening it." },
  { match: /gdms dashboard is ready|home screen detected/i, text: "GDMS home screen is ready." },
  { match: /session active.*skipping login/i, text: "Reusing saved browser login (no OTP needed)." },
  {
    match: /executable doesn't exist|playwright install chromium/i,
    text: "Browser automation is not installed on the server.",
  },
  {
    match: /JSON at position|gdms_bootstrap|bootstrap cookies/i,
    text: "Saved GDMS login token invalid — use Settings or Dashboard → Use GDMS login token again.",
  },
  { match: /profile appears to be in use/i, text: "Browser profile was locked — retrying launch." },
  { match: /live updates disconnected/i, text: "Live connection lost — logs may be delayed; automation can still run on the server." },
  { match: /^error:/i, text: "Error:" },
  { match: /bootstrap cookies applied/i, text: "Saved GDMS login applied — checking home screen." },
  { match: /browser input locked/i, text: "GDMS window is controlled by automation — use Pause or Stop on this page." },
  { match: /resuming enquiry transfer|resuming from saved browser/i, text: "Continuing enquiry transfer on the saved browser." },
  { match: /restart(ing)? enquiry transfer/i, text: "Restarting enquiry transfer on the open browser." },
  { match: /waiting for gdms dashboard|still waiting for dashboard/i, text: "Waiting for GDMS home screen after login." },
  { match: /otp step pending|still on login url/i, text: "Still on login — submit OTP on this page if asked." },
  { match: /paused from live session/i, text: "You paused automation from Live session." },
  { match: /stopped from live session/i, text: "You stopped automation from Live session." },
  { match: /pause confirmed|resume confirmed|stop confirmed/i, text: "Your control command was accepted." },
  { match: /sample rows:/i, text: "No matching enquiry in the table — sample rows logged for support." },
];

export function userFacingLogMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  for (const { match, text } of REPLACEMENTS) {
    const m = trimmed.match(match);
    if (m) {
      if (m[1] && text.includes("$1")) return text.replace("$1", m[1].toLowerCase());
      return text;
    }
  }
  if (trimmed.length > 220) {
    return `${trimmed.slice(0, 217)}…`;
  }
  return trimmed;
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

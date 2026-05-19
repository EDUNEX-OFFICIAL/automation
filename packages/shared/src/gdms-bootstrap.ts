/** Redis key for dealer-scoped GDMS login cookies (BNES_JSESSIONID from DevTools). */
export function gdmsBootstrapRedisKey(dealerId: string): string {
  return `dealer:${dealerId}:gdms_bootstrap_cookies`;
}

export type GdmsBootstrapCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
};

const GDMS_COOKIE_HOST = "ndms.hmil.net";

export function cookiesFromBnesToken(token: string): GdmsBootstrapCookie[] {
  const value = token.trim();
  return [
    {
      name: "BNES_JSESSIONID",
      value,
      domain: GDMS_COOKIE_HOST,
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ];
}

/** Parse DevTools cookie JSON array or a single BNES token string. */
export function parseGdmsBootstrapInput(raw: string): GdmsBootstrapCookie[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Cookie JSON must be an array");
    return parsed.map((item) => {
      const c = item as Record<string, unknown>;
      if (typeof c.name !== "string" || typeof c.value !== "string") {
        throw new Error("Each cookie needs name and value");
      }
      return {
        name: c.name,
        value: c.value,
        domain: typeof c.domain === "string" ? c.domain : GDMS_COOKIE_HOST,
        path: typeof c.path === "string" ? c.path : "/",
        httpOnly: c.httpOnly === true,
        secure: c.secure !== false,
      };
    });
  }
  return cookiesFromBnesToken(trimmed);
}

/** Workflow run id (cuid), not a GDMS cookie token. */
export function isWorkflowRunId(input: string): boolean {
  const s = input.trim();
  return /^c[a-z0-9]{20,30}$/i.test(s);
}

export function looksLikeGdmsCookieToken(input: string): boolean {
  const s = input.trim();
  return s.length > 60 && !isWorkflowRunId(s);
}

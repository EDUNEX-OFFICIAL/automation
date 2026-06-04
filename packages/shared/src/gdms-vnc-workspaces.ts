/** noVNC / Xvfb workspaces inside automation-service. */

export type GdmsVncWorkspaceId = 1 | 2;

/** Legacy shared workspaces (deprecated — use per-user slots). */
export const GDMS_VNC_WORKSPACE = {
  1: {
    id: 1 as const,
    label: "Enquiry transfer",
    display: ":99",
    rfbPort: 5900,
    websockifyPort: 6080,
    pathPrefix: "gdms-browser",
  },
  2: {
    id: 2 as const,
    label: "Follow Up Skip",
    display: ":100",
    rfbPort: 5901,
    websockifyPort: 6081,
    pathPrefix: "gdms-browser-2",
  },
} as const;

export const GDMS_USER_VNC_SLOT_COUNT = 16;

const ENQUIRY_DISPLAY_BASE = 101;
const FOLLOW_UP_DISPLAY_BASE = 117;
const ENQUIRY_RFB_BASE = 5902;
const FOLLOW_UP_RFB_BASE = 5918;
const ENQUIRY_WEBSOCKIFY_BASE = 6082;
const FOLLOW_UP_WEBSOCKIFY_BASE = 6098;

export function vncWorkspaceForOperation(operation: string): GdmsVncWorkspaceId {
  return operation === "follow_up_skip" ? 2 : 1;
}

/** @deprecated Use displayForUserOperation */
export function displayForOperation(operation: string): string {
  return GDMS_VNC_WORKSPACE[vncWorkspaceForOperation(operation)].display;
}

export function userVncSlotIndex(userId: string): number {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % GDMS_USER_VNC_SLOT_COUNT;
}

export function displayForUserOperation(userId: string, operation: string): string {
  const slot = userVncSlotIndex(userId);
  const base = operation === "follow_up_skip" ? FOLLOW_UP_DISPLAY_BASE : ENQUIRY_DISPLAY_BASE;
  return `:${base + slot}`;
}

export function rfbPortForUserOperation(userId: string, operation: string): number {
  const slot = userVncSlotIndex(userId);
  const base = operation === "follow_up_skip" ? FOLLOW_UP_RFB_BASE : ENQUIRY_RFB_BASE;
  return base + slot;
}

export function websockifyPortForUserOperation(userId: string, operation: string): number {
  const slot = userVncSlotIndex(userId);
  const base = operation === "follow_up_skip" ? FOLLOW_UP_WEBSOCKIFY_BASE : ENQUIRY_WEBSOCKIFY_BASE;
  return base + slot;
}

/** Public URL path prefix (proxied to websockifyPortForUserOperation). */
export function vncPathPrefixForUserOperation(userId: string, operation: string): string {
  const slot = userVncSlotIndex(userId);
  const kind = operation === "follow_up_skip" ? "fup" : "enq";
  return `gdms-browser-${kind}-u${slot}`;
}

export function browserProfileKeyForUser(
  dealerId: string,
  operation: string,
  userId: string,
): string {
  if (operation === "follow_up_skip") return `${dealerId}__${userId}__follow-up-skip`;
  return `${dealerId}__${userId}`;
}

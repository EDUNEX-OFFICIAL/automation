/** noVNC / Xvfb workspaces inside automation-service. */

export type GdmsVncWorkspaceId = 1 | 2 | 3;

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

function usesFollowUpVncSlot(operation: string): boolean {
  return operation === "follow_up_skip" || operation === "lost_inquiry";
}

export function vncWorkspaceForOperation(operation: string): GdmsVncWorkspaceId {
  if (operation === "lost_inquiry") return 3;
  if (operation === "follow_up_skip" || operation === "follow_up") return 2;
  return 1;
}

/** Map Live session tab / workspace id to automation operation. */
export function operationForVncWorkspace(workspaceId: GdmsVncWorkspaceId): string {
  if (workspaceId === 3) return "lost_inquiry";
  if (workspaceId === 2) return "follow_up_skip";
  return "enquiry_transfer";
}

export const LIVE_SESSION_VNC_TAB_LABELS: Record<GdmsVncWorkspaceId, string> = {
  1: "Enquiry Transfer",
  2: "Follow Up Skip",
  3: "Lost Inquiry",
};

/** @deprecated Use displayForUserOperation */
export function displayForOperation(operation: string): string {
  const ws = vncWorkspaceForOperation(operation);
  if (ws === 3) return GDMS_VNC_WORKSPACE[2].display;
  return GDMS_VNC_WORKSPACE[ws].display;
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
  const base = usesFollowUpVncSlot(operation) ? FOLLOW_UP_DISPLAY_BASE : ENQUIRY_DISPLAY_BASE;
  return `:${base + slot}`;
}

export function rfbPortForUserOperation(userId: string, operation: string): number {
  const slot = userVncSlotIndex(userId);
  const base = usesFollowUpVncSlot(operation) ? FOLLOW_UP_RFB_BASE : ENQUIRY_RFB_BASE;
  return base + slot;
}

export function websockifyPortForUserOperation(userId: string, operation: string): number {
  const slot = userVncSlotIndex(userId);
  const base = usesFollowUpVncSlot(operation) ? FOLLOW_UP_WEBSOCKIFY_BASE : ENQUIRY_WEBSOCKIFY_BASE;
  return base + slot;
}

/** Public URL path prefix (proxied to websockifyPortForUserOperation). */
export function vncPathPrefixForUserOperation(userId: string, operation: string): string {
  const slot = userVncSlotIndex(userId);
  const kind =
    operation === "lost_inquiry" || operation === "follow_up_skip" ? "fup" : "enq";
  return `gdms-browser-${kind}-u${slot}`;
}

export function browserProfileKeyForUser(
  dealerId: string,
  operation: string,
  userId: string,
): string {
  if (operation === "follow_up_skip") return `${dealerId}__${userId}__follow-up-skip`;
  if (operation === "lost_inquiry") return `${dealerId}__${userId}__lost-inquiry`;
  return `${dealerId}__${userId}`;
}

/** noVNC / Xvfb workspaces inside automation-service (parallel browsers). */
export type GdmsVncWorkspaceId = 1 | 2;

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

export function vncWorkspaceForOperation(operation: string): GdmsVncWorkspaceId {
  return operation === "follow_up_skip" ? 2 : 1;
}

export function displayForOperation(operation: string): string {
  return GDMS_VNC_WORKSPACE[vncWorkspaceForOperation(operation)].display;
}

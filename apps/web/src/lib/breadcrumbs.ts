import { homePathForRole } from "@/lib/roles";

const LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  "live-session": "Live session",
  leads: "Leads",
  users: "Team",
  settings: "Settings",
  profile: "Profile",
  platform: "Platform",
  dealers: "Dealers",
};

export type Breadcrumb = { label: string; href?: string };

export function breadcrumbsForPath(
  pathname: string | null,
  role?: string | undefined,
): Breadcrumb[] {
  const homeHref = homePathForRole(role);
  const homeLabel = role === "SUPER_ADMIN" ? "Dealers" : role === "DEALER_ADMIN" ? "Team" : "Dashboard";

  if (!pathname || pathname === "/") {
    return [{ label: homeLabel }];
  }
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [{ label: homeLabel, href: homeHref }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({
      label: LABELS[part] ?? part.replace(/-/g, " "),
      href: acc,
    });
  }
  const last = crumbs[crumbs.length - 1];
  if (last) delete last.href;
  return crumbs;
}

export function pageTitleForPath(pathname: string | null): string {
  if (!pathname || pathname === "/") return "GDMS Automation";
  const parts = pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return LABELS[last ?? ""] ?? (last?.replace(/-/g, " ") ?? "GDMS Automation");
}

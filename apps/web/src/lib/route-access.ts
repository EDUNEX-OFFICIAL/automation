import { homePathForRole } from "@/lib/roles";

/** Paths that require Team Leader or Sales Consultant automation access. */
const AUTOMATION_PATHS = ["/live-session", "/operations"];

/** Dashboard: automation operators + dealer admin analytics view. */
const DASHBOARD_PATHS = ["/dashboard"];

/** Paths restricted by role (prefix match). */
const LEADS_PATHS = ["/leads"];
const SETTINGS_PATHS = ["/settings"];
const USERS_PATHS = ["/users"];
const PLATFORM_PATHS = ["/platform"];

export function canViewAutomationStats(role: string | undefined): boolean {
  return (
    role === "SUPER_ADMIN" ||
    role === "DEALER_ADMIN" ||
    role === "TEAM_LEADER" ||
    role === "SALES_CONSULTANT"
  );
}

export function canViewDashboard(role: string | undefined): boolean {
  return canViewAutomationStats(role);
}

export function canViewLeads(role: string | undefined): boolean {
  return role === "TEAM_LEADER" || role === "SALES_CONSULTANT" || role === "DEALER_ADMIN";
}

export function canAccessSettings(role: string | undefined): boolean {
  return (
    role === "DEALER_ADMIN" || role === "TEAM_LEADER" || role === "SALES_CONSULTANT"
  );
}

export function canManageUsersPage(role: string | undefined): boolean {
  return role === "DEALER_ADMIN" || role === "TEAM_LEADER";
}

export function canRunAutomation(role: string | undefined): boolean {
  return role === "TEAM_LEADER" || role === "SALES_CONSULTANT";
}

export function canAccessPlatform(role: string | undefined): boolean {
  return role === "SUPER_ADMIN";
}

export function isPathAllowedForRole(pathname: string, role: string | undefined): boolean {
  if (!role) return false;
  if (pathname.startsWith("/profile")) return true;
  if (PLATFORM_PATHS.some((p) => pathname.startsWith(p))) {
    return canAccessPlatform(role);
  }
  if (DASHBOARD_PATHS.some((p) => pathname.startsWith(p))) {
    return canViewDashboard(role);
  }
  if (AUTOMATION_PATHS.some((p) => pathname.startsWith(p))) {
    return canRunAutomation(role);
  }
  if (LEADS_PATHS.some((p) => pathname.startsWith(p))) {
    return canViewLeads(role);
  }
  if (SETTINGS_PATHS.some((p) => pathname.startsWith(p))) {
    return canAccessSettings(role);
  }
  if (USERS_PATHS.some((p) => pathname.startsWith(p))) {
    return canManageUsersPage(role);
  }
  return true;
}

export function redirectForBlockedPath(pathname: string, role: string | undefined): string {
  return homePathForRole(role);
}

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Building2,
  LayoutDashboard,
  Settings,
  User,
  UserCog,
  Users,
} from "lucide-react";

export type AppRole =
  | "SUPER_ADMIN"
  | "DEALER_ADMIN"
  | "TEAM_LEADER"
  | "SALES_CONSULTANT";

export type TeamType = "DIGITAL" | "FIELD";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  section: "Operations" | "Administration" | "Account";
};

export type NavSection = { title: string; items: NavItem[] };

export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: "Super Admin",
  DEALER_ADMIN: "Dealer Admin",
  TEAM_LEADER: "Team Leader",
  SALES_CONSULTANT: "Sales Consultant",
};

export const TEAM_TYPE_LABELS: Record<TeamType, string> = {
  DIGITAL: "Digital team",
  FIELD: "Field team",
};

export function canRunAutomation(role: string | undefined): boolean {
  return role === "TEAM_LEADER" || role === "SALES_CONSULTANT";
}

export function canViewLeads(role: string | undefined): boolean {
  return canRunAutomation(role) || role === "DEALER_ADMIN";
}

export function canAccessSettings(role: string | undefined): boolean {
  return role === "DEALER_ADMIN" || canRunAutomation(role);
}

export function canManageUsersPage(role: string | undefined): boolean {
  return role === "DEALER_ADMIN" || role === "TEAM_LEADER";
}

/** Follow Up Skip schedule on Settings — not available to Sales Consultant. */
export function canEditScheduleSettings(role: string | undefined): boolean {
  return role === "TEAM_LEADER" || role === "DEALER_ADMIN";
}

export function navForRole(role: string | undefined): NavItem[] {
  return navSectionsForRole(role).flatMap((s) => s.items);
}

export function navSectionsForRole(role: string | undefined): NavSection[] {
  const group = (title: string, list: NavItem[]): NavSection => ({ title, items: list });

  switch (role) {
    case "SUPER_ADMIN":
      return [
        group("Platform", [
          { href: "/platform/dealers", label: "Dealers", icon: Building2, section: "Administration" },
        ]),
        group("Account", [
          { href: "/profile", label: "Profile", icon: User, section: "Account" },
        ]),
      ];
    case "DEALER_ADMIN":
      return [
        group("Administration", [
          { href: "/users", label: "Team", icon: UserCog, section: "Administration" },
          { href: "/leads", label: "Leads", icon: Users, section: "Administration" },
          { href: "/settings", label: "Settings", icon: Settings, section: "Administration" },
        ]),
        group("Account", [
          { href: "/profile", label: "Profile", icon: User, section: "Account" },
        ]),
      ];
    case "TEAM_LEADER":
      return [
        group("Operations", [
          { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, section: "Operations" },
          { href: "/live-session", label: "Live session", icon: Activity, section: "Operations" },
          { href: "/leads", label: "Leads", icon: Users, section: "Operations" },
        ]),
        group("Team", [
          { href: "/users", label: "My team", icon: UserCog, section: "Administration" },
          { href: "/settings", label: "GDMS & schedule", icon: Settings, section: "Administration" },
        ]),
        group("Account", [
          { href: "/profile", label: "Profile", icon: User, section: "Account" },
        ]),
      ];
    case "SALES_CONSULTANT":
      return [
        group("Operations", [
          { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, section: "Operations" },
          { href: "/live-session", label: "Live session", icon: Activity, section: "Operations" },
          { href: "/leads", label: "Leads", icon: Users, section: "Operations" },
        ]),
        group("Configuration", [
          { href: "/settings", label: "GDMS login", icon: Settings, section: "Administration" },
        ]),
        group("Account", [
          { href: "/profile", label: "Profile", icon: User, section: "Account" },
        ]),
      ];
    default:
      return [];
  }
}

export function homePathForRole(role: string | undefined): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "/platform/dealers";
    case "DEALER_ADMIN":
      return "/users";
    case "TEAM_LEADER":
    case "SALES_CONSULTANT":
      return "/dashboard";
    default:
      return "/login";
  }
}

import type { Role } from "./jwt.js";

export function isPlatformRole(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

export function isDealerAdminRole(role: Role): boolean {
  return role === "DEALER_ADMIN";
}

export function canRunAutomation(role: Role): boolean {
  return role === "TEAM_LEADER" || role === "SALES_CONSULTANT";
}

export function canManageDealers(role: Role): boolean {
  return role === "SUPER_ADMIN";
}

export function canManageDealerUsers(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "DEALER_ADMIN";
}

/** Team Leader can create and manage their own Sales Consultants. */
export function canManageOwnTeamScUsers(role: Role): boolean {
  return role === "TEAM_LEADER";
}

export function canAccessTeamUsersApi(role: Role): boolean {
  return canManageDealerUsers(role) || canManageOwnTeamScUsers(role);
}

/** @deprecated use canManageDealerUsers */
export function canManageUsers(role: Role): boolean {
  return canManageDealerUsers(role);
}

/** Save own GDMS credentials (TL / SC). */
export function canEditOwnGdmsSecrets(role: Role): boolean {
  return canRunAutomation(role);
}

/** Admin can set GDMS credentials for any TL/SC in their dealer. */
export function canEditTeamGdmsSecrets(role: Role): boolean {
  return role === "DEALER_ADMIN";
}

/** Dealer-wide Follow Up Skip schedule (Settings) — Team Leader and Dealer Admin only. */
export function canEditDealerAutomationSettings(role: Role): boolean {
  return role === "TEAM_LEADER" || role === "DEALER_ADMIN";
}

/** Enquiry / follow-up remark rules on Settings (TL + Dealer Admin only). */
export function canEditRemarkAutomationSettings(role: Role): boolean {
  return role === "TEAM_LEADER" || role === "DEALER_ADMIN";
}

/** @deprecated */
export function canEditGdmsSecrets(role: Role): boolean {
  return canEditOwnGdmsSecrets(role) || canEditTeamGdmsSecrets(role);
}

/** @deprecated use canRunAutomation */
export function canStartWorkflow(role: Role): boolean {
  return canRunAutomation(role);
}

export function canViewLeads(role: Role): boolean {
  return canRunAutomation(role) || role === "DEALER_ADMIN";
}

export function canAccessDealer(userDealerId: string | null, targetDealerId: string, role: Role): boolean {
  if (role === "SUPER_ADMIN") return true;
  return userDealerId === targetDealerId;
}

type WorkflowRunActor = { sub: string; role: Role; dealerId: string | null };
type WorkflowRunRef = { dealerId: string; startedByUserId: string | null };

/** TL/SC may only view or control workflow runs they started. */
export function canAccessWorkflowRun(actor: WorkflowRunActor, run: WorkflowRunRef): boolean {
  if (!canAccessDealer(actor.dealerId, run.dealerId, actor.role)) return false;
  if (canRunAutomation(actor.role)) {
    return run.startedByUserId === actor.sub;
  }
  if (actor.role === "SUPER_ADMIN" || actor.role === "DEALER_ADMIN") return true;
  return false;
}

/** Prisma-style filter: automation users are scoped to their own runs. */
export function workflowRunScopeForActor(
  actor: WorkflowRunActor,
  base: { dealerId: string },
): { dealerId: string; startedByUserId?: string } {
  if (canRunAutomation(actor.role)) {
    return { dealerId: base.dealerId, startedByUserId: actor.sub };
  }
  return { dealerId: base.dealerId };
}

/** Edit profile (name, username, password, avatar) — self or direct/indirect report. */
export function canEditUserProfile(
  actor: { sub: string; role: Role; dealerId: string | null },
  target: {
    id: string;
    role: Role;
    dealerId: string | null;
    reportsToUserId: string | null;
  },
): boolean {
  if (actor.sub === target.id) return true;
  if (actor.role === "SUPER_ADMIN") {
    if (target.role === "SUPER_ADMIN" && actor.sub !== target.id) return false;
    return true;
  }
  if (actor.role === "DEALER_ADMIN") {
    if (!actor.dealerId || target.dealerId !== actor.dealerId) return false;
    return target.role === "TEAM_LEADER" || target.role === "SALES_CONSULTANT";
  }
  if (actor.role === "TEAM_LEADER") {
    return target.reportsToUserId === actor.sub && target.role === "SALES_CONSULTANT";
  }
  return false;
}

export function rolesCreatableBy(actor: Role): Role[] {
  if (actor === "SUPER_ADMIN") return ["DEALER_ADMIN"];
  if (actor === "DEALER_ADMIN") return ["TEAM_LEADER", "SALES_CONSULTANT"];
  if (actor === "TEAM_LEADER") return ["SALES_CONSULTANT"];
  return [];
}

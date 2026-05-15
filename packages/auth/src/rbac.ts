import type { Role } from "./jwt.js";

export function canManageUsers(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "DEALER";
}

export function canEditGdmsSecrets(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "DEALER";
}

export function canStartWorkflow(role: Role): boolean {
  return role === "SUPER_ADMIN" || role === "DEALER" || role === "USER";
}

export function canAccessDealer(userDealerId: string | null, targetDealerId: string, role: Role): boolean {
  if (role === "SUPER_ADMIN") return true;
  return userDealerId === targetDealerId;
}

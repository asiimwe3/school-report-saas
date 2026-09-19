/**
 * Tenant isolation core. The pattern every API handler MUST use:
 *
 *   const scope = requireScope(memberships, requestedSchoolId);
 *   // scope.schoolId is the ONLY schoolId any query may touch.
 *
 * A user without an ACTIVE membership in the school can never read or mutate
 * its records, regardless of what the request body says.
 */
import type { Role } from "./rbac";

export interface MembershipRef {
  schoolId: string;
  role: Role;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REMOVED";
}

export interface Scope {
  schoolId: string;
  role: Role;
}

export function requireScope(
  memberships: MembershipRef[],
  requestedSchoolId: string | null | undefined
): Scope {
  const active = memberships.filter((m) => m.status === "ACTIVE");
  if (requestedSchoolId) {
    const m = active.find((x) => x.schoolId === requestedSchoolId);
    if (!m) throw new TenantAccessError("No active membership in this school");
    return { schoolId: m.schoolId, role: m.role };
  }
  // No explicit school: only safe if the user has exactly one active membership.
  if (active.length === 1) {
    return { schoolId: active[0]!.schoolId, role: active[0]!.role };
  }
  throw new TenantAccessError("Ambiguous school context; specify schoolId");
}

export class TenantAccessError extends Error {
  readonly code = "TENANT_ACCESS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "TenantAccessError";
  }
}

/** Prisma query helper: the scope's schoolId is injected server-side. */
export const scoped = (
  scope: Scope,
  where: Record<string, unknown> = {}
): Record<string, unknown> => ({
  ...where,
  schoolId: scope.schoolId,
});

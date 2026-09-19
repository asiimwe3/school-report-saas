/**
 * Server-side RBAC. Roles are NEVER taken from a client request — they come
 * from the authenticated membership row. Every permission check in the API
 * layer goes through can() / canTeacher().
 */
export type Role =
  | "SCHOOL_OWNER"
  | "HEAD_TEACHER"
  | "SCHOOL_ADMIN"
  | "TEACHER"
  | "BURSAR"
  | "DATA_ENTRY";

export type Action =
  // school & staff
  | "school:manage_settings"
  | "school:manage_staff"
  | "billing:manage"
  // academic structure
  | "structure:manage" // years, terms, classes, streams, subjects, combinations
  | "students:view"
  | "students:manage"
  // marks
  | "marks:view"
  | "marks:enter"
  | "marks:import"
  | "marks:approve"
  | "marks:lock"
  | "marks:unlock"
  // results & reports
  | "results:view"
  | "reports:generate"
  | "reports:manage_templates"
  // fees
  | "fees:view"
  | "fees:record"
  | "fees:manage"
  // audit & backup
  | "audit:view"
  | "backup:manage"
  | "backup:restore"
  // comments
  | "comments:write_class"
  | "comments:write_head";

const ROLE_PERMISSIONS: Record<Role, Action[]> = {
  SCHOOL_OWNER: [
    "school:manage_settings", "school:manage_staff", "billing:manage",
    "structure:manage", "students:view", "students:manage",
    "marks:view", "marks:enter", "marks:import", "marks:approve", "marks:lock", "marks:unlock",
    "results:view", "reports:generate", "reports:manage_templates",
    "fees:view", "fees:record", "fees:manage",
    "audit:view", "backup:manage", "backup:restore",
    "comments:write_class", "comments:write_head",
  ],
  HEAD_TEACHER: [
    "structure:manage", "students:view", "students:manage",
    "marks:view", "marks:enter", "marks:import", "marks:approve", "marks:lock", "marks:unlock",
    "results:view", "reports:generate",
    "fees:view",
    "audit:view",
    "comments:write_class", "comments:write_head",
  ],
  SCHOOL_ADMIN: [
    "structure:manage", "students:view", "students:manage",
    "marks:view", "marks:import",
    "results:view", "reports:generate",
    "fees:view",
    "audit:view",
    "comments:write_class",
  ],
  TEACHER: [
    "marks:view", "marks:enter",
    "students:view",
    "comments:write_class", // only for their own class (context-checked)
  ],
  BURSAR: [
    "students:view",
    "fees:view", "fees:record", "fees:manage",
  ],
  DATA_ENTRY: [
    "students:view", "students:manage",
    "marks:view", "marks:enter", "marks:import",
    "results:view",
    "fees:view", "fees:record",
  ],
};

export const can = (role: Role, action: Action): boolean =>
  ROLE_PERMISSIONS[role]?.includes(action) ?? false;

/** Roles that may be granted via invite — server-controlled only. */
export const INVITABLE_ROLES: Role[] = [
  "HEAD_TEACHER", "SCHOOL_ADMIN", "TEACHER", "BURSAR", "DATA_ENTRY",
];

/**
 * Teacher context check: a teacher may only act within their assigned
 * class+subject (or, with the explicit classTeacher grant, anywhere in their
 * class). Assignments come from the DB, never the client.
 */
export interface AssignmentRef {
  teacherId: string;
  subjectId: string;
  classId: string;
  classTeacher: boolean;
  active: boolean;
}

export function canTeacher(
  assignments: AssignmentRef[],
  teacherId: string,
  classId: string,
  subjectId?: string
): boolean {
  const mine = assignments.filter(
    (a) => a.active && a.teacherId === teacherId
  );
  if (mine.some((a) => a.classId === classId && a.classTeacher)) return true;
  if (subjectId === undefined) return false;
  return mine.some((a) => a.classId === classId && a.subjectId === subjectId);
}

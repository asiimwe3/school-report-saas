/** Uniform mapping of ServiceError codes to HTTP statuses. */
export function serviceErrorToResponse(e: unknown): Response {
  const anyE = e as { code?: string; message?: string };
  const status =
    anyE?.code === "FORBIDDEN" || anyE?.code === "TENANT_ACCESS_DENIED" ? 403
    : anyE?.code === "NOT_FOUND" ? 404
    : anyE?.code === "VERSION_CONFLICT" ? 409
    : anyE?.code === "SHEET_LOCKED" ? 423
    : anyE?.code === "STATE_CONFLICT" ? 409
    : anyE?.code === "VALIDATION" ? 400
    : 500;
  return Response.json(
    { error: { code: anyE?.code ?? "INTERNAL", message: anyE?.message ?? "Unexpected error" } },
    { status }
  );
}

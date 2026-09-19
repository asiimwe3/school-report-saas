"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

interface SheetsResp {
  sheets: { id: string; classId: string; className: string; subjectId: string; subjectName: string; termId: string; termName: string; state: string }[];
}

export default function ApprovePage() {
  const { schoolId, me } = useMe();
  const [sheets, setSheets] = useState<SheetsResp["sheets"]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlockFor, setUnlockFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function refresh() {
    if (!schoolId) return;
    try {
      const d = await get<SheetsResp>(`/api/sheets?schoolId=${schoolId}`);
      setSheets(d.sheets);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    refresh();
  }, [schoolId]);

  async function transition(sheet: SheetsResp["sheets"][number], to: string) {
    setBusyId(sheet.id);
    setErr(null);
    try {
      await post("/api/sheets/transition", {
        schoolId, classId: sheet.classId, subjectId: sheet.subjectId, termId: sheet.termId, to,
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transition failed");
    } finally {
      setBusyId(null);
    }
  }

  async function unlock(sheet: SheetsResp["sheets"][number]) {
    if (reason.trim().length < 5) {
      setErr("Give a reason of at least 5 characters to unlock.");
      return;
    }
    setBusyId(sheet.id);
    setErr(null);
    try {
      await post("/api/sheets/unlock", {
        schoolId, classId: sheet.classId, subjectId: sheet.subjectId, termId: sheet.termId, reason,
      });
      setUnlockFor(null);
      setReason("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unlock failed");
    } finally {
      setBusyId(null);
    }
  }

  const role = me?.schools.find((s) => s.id === schoolId)?.role;
  const canApprove = role === "SCHOOL_OWNER" || role === "HEAD_TEACHER";
  const canUnlock = canApprove;

  const pending = sheets.filter((s) => s.state === "SUBMITTED" || s.state === "REVIEWED");
  const final = sheets.filter((s) => s.state === "APPROVED" || s.state === "LOCKED");

  return (
    <>
      <h1>Approvals</h1>
      <p className="sub">
        {canApprove
          ? "Review submitted mark sheets and approve them for reporting."
          : "Only the head teacher or owner can approve sheets — you can review the queue."}
      </p>
      {err && <div className="err">{err}</div>}

      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Awaiting action ({pending.length})</h2>
        <table>
          <thead><tr><th>Class</th><th>Subject</th><th>Term</th><th>State</th><th>Action</th></tr></thead>
          <tbody>
            {pending.map((s) => (
              <tr key={s.id}>
                <td>{s.className}</td>
                <td>{s.subjectName}</td>
                <td>{s.termName}</td>
                <td><span className={`badge ${s.state}`}>{s.state}</span></td>
                <td>
                  {canApprove ? (
                    <>
                      {s.state === "SUBMITTED" && (
                        <button className="ghost" style={{ marginTop: 0 }} disabled={busyId === s.id}
                          onClick={() => transition(s, "REVIEWED")}>Review</button>
                      )}
                      <button className="ghost" style={{ marginTop: 0 }} disabled={busyId === s.id}
                        onClick={() => transition(s, "APPROVED")}>Approve</button>
                      <button className="ghost danger" style={{ marginTop: 0 }} disabled={busyId === s.id}
                        onClick={() => transition(s, "DRAFT")}>Return</button>
                    </>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
            {pending.length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>Nothing waiting.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Final sheets ({final.length})</h2>
        <table>
          <thead><tr><th>Class</th><th>Subject</th><th>Term</th><th>State</th><th>Action</th></tr></thead>
          <tbody>
            {final.map((s) => (
              <tr key={s.id}>
                <td>{s.className}</td>
                <td>{s.subjectName}</td>
                <td>{s.termName}</td>
                <td><span className={`badge ${s.state}`}>{s.state}</span></td>
                <td>
                  {canUnlock ? (
                    s.state === "APPROVED" ? (
                      <button className="ghost" style={{ marginTop: 0 }} disabled={busyId === s.id}
                        onClick={() => transition(s, "LOCKED")}>Lock</button>
                    ) : (
                      <button className="ghost danger" style={{ marginTop: 0 }} disabled={busyId === s.id}
                        onClick={() => setUnlockFor(unlockFor === s.id ? null : s.id)}>Unlock…</button>
                    )
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                  {unlockFor === s.id && (
                    <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                      <input
                        placeholder="Reason (recorded in the audit log)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button className="ghost danger" style={{ marginTop: 0 }} disabled={busyId === s.id}
                        onClick={() => unlock(s)}>Confirm unlock</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {final.length === 0 && <tr><td colSpan={5} style={{ color: "var(--muted)" }}>No final sheets yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { get, post } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

interface Roster {
  classes: { id: string; name: string }[];
  subjects: { id: string; name: string }[];
  terms: { id: string; name: string }[];
  components: { id: string; code: string; kind: string }[];
}
interface StudentsResp { students: { id: string; name: string; admissionNo: string; rollNo: number | null }[] }
interface MarksResp {
  sheetState: string;
  marks: { studentId: string; componentId: string; type: string; score: number | null; maxScore: number; version: number }[];
}

const SPECIAL = ["VALUE", "ABS", "MISSING", "EXEMPT", "NA"];

export default function MarksPage() {
  const { schoolId, me } = useMe();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [classId, setClassId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [termId, setTermId] = useState("");
  const [students, setStudents] = useState<StudentsResp["students"]>([]);
  const [marks, setMarks] = useState<MarksResp | null>(null);
  // draft[cellKey] = { type, score }
  const [draft, setDraft] = useState<Record<string, { type: string; score: number | null }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    get<Roster>(`/api/roster?schoolId=${schoolId}`)
      .then((r) => {
        setRoster(r);
        const active = r.terms.find((t) => t.id === "") ?? r.terms[0];
        if (active) setTermId(active.id);
      })
      .catch((e) => setErr(e.message));
  }, [schoolId]);

  const loadSheet = useCallback(async () => {
    if (!schoolId || !classId || !subjectId || !termId) return;
    setErr(null);
    try {
      const [s, m] = await Promise.all([
        get<StudentsResp>(`/api/students?schoolId=${schoolId}&classId=${classId}&termId=${termId}`),
        get<MarksResp>(`/api/marks?schoolId=${schoolId}&classId=${classId}&subjectId=${subjectId}&termId=${termId}`),
      ]);
      setStudents(s.students);
      setMarks(m);
      const d: Record<string, { type: string; score: number | null }> = {};
      for (const st of s.students) {
        for (const c of roster?.components ?? []) {
          const existing = m.marks.find((x) => x.studentId === st.id && x.componentId === c.id);
          d[`${st.id}|${c.id}`] = existing
            ? { type: existing.type, score: existing.score }
            : { type: "VALUE", score: null };
        }
      }
      setDraft(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load sheet");
    }
  }, [schoolId, classId, subjectId, termId, roster]);

  async function save(studentId: string, componentId: string) {
    const cell = draft[`${studentId}|${componentId}`];
    if (!cell) return;
    setBusy(true);
    setErr(null);
    try {
      await post("/api/marks", {
        schoolId,
        studentId,
        subjectId,
        termId,
        componentId,
        type: cell.type,
        score: cell.type === "VALUE" ? cell.score : null,
      });
      setMsg("Saved");
      setTimeout(() => setMsg(null), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitSheet(to: string) {
    setBusy(true);
    setErr(null);
    try {
      await post("/api/sheets/transition", { schoolId, classId, subjectId, termId, to });
      setMsg(`Sheet ${to.toLowerCase()}`);
      await loadSheet();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transition failed");
    } finally {
      setBusy(false);
    }
  }

  const editable = marks?.sheetState === "DRAFT" || marks?.sheetState === "SUBMITTED" || marks?.sheetState === "REVIEWED";
  const role = me?.schools.find((s) => s.id === schoolId)?.role;
  const canApprove = role === "SCHOOL_OWNER" || role === "HEAD_TEACHER";

  if (!roster) return <p className="sub">Loading…</p>;

  return (
    <>
      <h1>Enter marks</h1>
      <p className="sub">Select the class, subject and term, then type scores. Changes save per cell.</p>
      <div className="card">
        <div className="grid cols">
          <div>
            <label>Class</label>
            <select value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Select class…</option>
              {roster.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label>Subject</label>
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">Select subject…</option>
              {roster.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label>Term</label>
            <select value={termId} onChange={(e) => setTermId(e.target.value)}>
              {roster.terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="ghost" style={{ width: "100%", marginTop: 0 }} onClick={loadSheet} disabled={!classId || !subjectId || !termId}>
              Open sheet
            </button>
          </div>
        </div>
      </div>

      {err && <div className="err">{err}</div>}
      {msg && <div style={{ color: "var(--ok)", fontSize: 14 }}>{msg}</div>}

      {students.length > 0 && roster.components.length > 0 && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <span className={`badge ${marks?.sheetState ?? "DRAFT"}`}>{marks?.sheetState ?? "DRAFT"}</span>
            {!editable && <span style={{ color: "var(--muted)", fontSize: 13 }}>Sheet is final — marks locked.</span>}
            {editable && (
              <>
                <button className="ghost" style={{ marginTop: 0 }} onClick={() => submitSheet("SUBMITTED")} disabled={busy}>Submit for approval</button>
                {canApprove && <button className="ghost" style={{ marginTop: 0 }} onClick={() => submitSheet("APPROVED")} disabled={busy}>Approve</button>}
              </>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th><th>Student</th>
                {roster.components.map((c) => <th key={c.id}>{c.code}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {students.map((st, i) => (
                <tr key={st.id}>
                  <td style={{ color: "var(--muted)" }}>{st.rollNo ?? i + 1}</td>
                  <td>{st.name}</td>
                  {roster.components.map((c) => {
                    const key = `${st.id}|${c.id}`;
                    const cell = draft[key] ?? { type: "VALUE", score: null };
                    return (
                      <td key={c.id}>
                        {cell.type === "VALUE" ? (
                          <input
                            className="cell"
                            type="number"
                            min={0}
                            max={100}
                            disabled={!editable}
                            value={cell.score ?? ""}
                            onChange={(e) =>
                              setDraft({ ...draft, [key]: { type: "VALUE", score: e.target.value === "" ? null : Number(e.target.value) } })
                            }
                          />
                        ) : (
                          <select
                            disabled={!editable}
                            value={cell.type}
                            onChange={(e) => setDraft({ ...draft, [key]: { type: e.target.value, score: null } })}
                            style={{ width: 100 }}
                          >
                            {SPECIAL.filter((t) => t !== "VALUE").map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <select
                      disabled={!editable}
                      value={draft[`${st.id}|${roster.components[0]?.id}`]?.type ?? "VALUE"}
                      onChange={(e) => {
                        const newType = e.target.value;
                        const updated = { ...draft };
                        for (const c of roster.components) {
                          updated[`${st.id}|${c.id}`] = newType === "VALUE"
                            ? { type: "VALUE", score: updated[`${st.id}|${c.id}`]?.score ?? null }
                            : { type: newType, score: null };
                        }
                        setDraft(updated);
                      }}
                      style={{ width: 110 }}
                      title="Set all components for this student"
                    >
                      {SPECIAL.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td>
                    {editable && roster.components.length > 0 && (
                      <button
                        className="ghost"
                        style={{ marginTop: 0, padding: "6px 10px" }}
                        onClick={async () => {
                          for (const c of roster.components) await save(st.id, c.id);
                        }}
                        disabled={busy}
                      >
                        Save
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

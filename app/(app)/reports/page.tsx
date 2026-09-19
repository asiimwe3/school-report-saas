"use client";
import { useEffect, useState } from "react";
import { get } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

interface RosterStudent { id: string; name: string; admissionNo: string; sex: string; }

export default function ReportsPage() {
  const { me, schoolId } = useMe();
  const termId = me?.schools.find((s) => s.id === schoolId)?.activeTermId ?? "";
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    get<{ classes: { id: string; name: string }[] }>(`/api/roster?schoolId=${schoolId}`)
      .then((d) => setClasses(d.classes))
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load classes"));
  }, [schoolId]);

  useEffect(() => {
    if (!classId || !termId) return;
    setStudents([]);
    get<{ students: RosterStudent[] }>(`/api/students?schoolId=${schoolId}&classId=${classId}&termId=${termId}`)
      .then((d) => setStudents(d.students))
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load students"));
  }, [classId, termId, schoolId]);

  const role = me?.schools.find((s) => s.id === schoolId)?.role;
  const canGen =
    role === "SCHOOL_OWNER" || role === "HEAD_TEACHER" || role === "SCHOOL_ADMIN" ||
    role === "TEACHER" || role === "DATA_ENTRY";

  const cardUrl = (sid: string, format: "html" | "docx") =>
    `/api/reports/card?schoolId=${schoolId}&studentId=${sid}&termId=${termId}&format=${format}`;

  return (
    <>
      <h1>Report Cards</h1>
      <p className="sub">Print-ready A4 terminal reports — PDF via print dialog, or editable DOCX.</p>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <select value={classId} onChange={(e) => setClassId(e.target.value)} className="input">
          <option value="">Select class…</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {students.length > 0 && (
          <span className="sub" style={{ alignSelf: "center" }}>{students.length} students</span>
        )}
      </div>

      {err && <div className="err">{err}</div>}
      {!canGen && <div className="err">Your role cannot generate reports.</div>}

      {students.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>#</th><th>Student</th><th>Adm. No</th><th>Sex</th><th>Report card</th></tr>
            </thead>
            <tbody>
              {students.map((s, i) => (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{s.name}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{s.admissionNo}</td>
                  <td>{s.sex}</td>
                  <td>
                    <a className="btn ghost" href={cardUrl(s.id, "html")} target="_blank" rel="noreferrer">PDF / Print</a>{" "}
                    <a className="btn" href={cardUrl(s.id, "docx")}>DOCX</a>
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

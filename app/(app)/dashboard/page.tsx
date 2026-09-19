"use client";
import { useEffect, useState } from "react";
import { get } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

interface SheetsResp {
  sheets: { id: string; className: string; subjectName: string; termName: string; state: string }[];
}

export default function DashboardPage() {
  const { schoolId } = useMe();
  const [sheets, setSheets] = useState<SheetsResp["sheets"]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    get<SheetsResp>(`/api/sheets?schoolId=${schoolId}`)
      .then((d) => setSheets(d.sheets))
      .catch(() => setSheets([]))
      .finally(() => setLoaded(true));
  }, [schoolId]);

  const count = (state: string) => sheets.filter((s) => s.state === state).length;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Mark sheet status across the school.</p>
      {!loaded ? (
        <p className="sub">Loading…</p>
      ) : (
        <>
          <div className="stats">
            <div className="stat"><b>{sheets.length}</b><span>Total sheets</span></div>
            <div className="stat"><b>{count("DRAFT")}</b><span>In progress</span></div>
            <div className="stat"><b>{count("SUBMITTED")}</b><span>Awaiting approval</span></div>
            <div className="stat"><b>{count("APPROVED")}</b><span>Approved</span></div>
            <div className="stat"><b>{count("LOCKED")}</b><span>Locked</span></div>
          </div>
          <div className="card" style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Recent sheets</h2>
            <table>
              <thead>
                <tr><th>Class</th><th>Subject</th><th>Term</th><th>State</th></tr>
              </thead>
              <tbody>
                {sheets.slice(0, 12).map((s) => (
                  <tr key={s.id}>
                    <td>{s.className}</td>
                    <td>{s.subjectName}</td>
                    <td>{s.termName}</td>
                    <td><span className={`badge ${s.state}`}>{s.state}</span></td>
                  </tr>
                ))}
                {sheets.length === 0 && (
                  <tr><td colSpan={4} style={{ color: "var(--muted)" }}>No sheets yet — create one by entering marks.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

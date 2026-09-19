"use client";
import { useRouter, usePathname } from "next/navigation";
import { post } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, schoolId, setSchoolId, error } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  async function logout() {
    await post("/api/auth/logout", {}).catch(() => {});
    localStorage.removeItem("csrfSecret");
    window.location.replace("/login");
  }

  if (error) return <div className="page"><div className="err">{error}</div></div>;
  if (!me) return <div className="page sub">Loading…</div>;
  if (me.schools.length === 0) {
    return (
      <div className="page">
        <div className="card">No school memberships yet. Ask your school owner for an invite.</div>
      </div>
    );
  }

  const activeSchool = me.schools.find((s) => s.id === schoolId);

  return (
    <>
      <header className="topbar">
        <span className="logo">DERY<span>CODE</span> REPORTS</span>
        <nav style={{ display: "flex", gap: 16 }}>
          <a href="/dashboard" style={{ color: pathname === "/dashboard" ? "var(--accent2)" : "var(--muted)" }}>Dashboard</a>
          <a href="/marks" style={{ color: pathname === "/marks" ? "var(--accent2)" : "var(--muted)" }}>Enter marks</a>
          <a href="/approve" style={{ color: pathname === "/approve" ? "var(--accent2)" : "var(--muted)" }}>Approvals</a>
          <a href="/billing" style={{ color: pathname === "/billing" ? "var(--accent2)" : "var(--muted)" }}>Billing</a>
        </nav>
        <span className="spacer" />
        <select
          value={schoolId}
          onChange={(e) => {
            setSchoolId(e.target.value);
            localStorage.setItem("schoolId", e.target.value);
            router.refresh();
          }}
        >
          {me.schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role.replace("_", " ")}
            </option>
          ))}
        </select>
        <button className="link" onClick={logout}>Sign out</button>
      </header>
      <main className="page">{children}</main>
      <span hidden>{activeSchool?.role}</span>
    </>
  );
}

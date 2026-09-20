"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/src/lib/client";

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [district, setDistrict] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await post<{ csrfSecret: string }>("/api/auth/register", {
        fullName,
        email,
        password,
        schoolName,
        district,
      });
      localStorage.setItem("csrfSecret", res.csrfSecret);
      router.replace("/dashboard");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>
          Create your <span style={{ color: "var(--accent2)" }}>school workspace</span>
        </h1>
        <p className="sub">You become the school owner — invite teachers and staff later.</p>
        <form onSubmit={submit}>
          <label htmlFor="fullName">Your full name</label>
          <input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            required
            minLength={2}
          />
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <label htmlFor="password">Password (min 8 characters)</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <label htmlFor="schoolName">School name</label>
          <input
            id="schoolName"
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
            required
            minLength={3}
          />
          <label htmlFor="district">District (optional)</label>
          <input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} />
          {err && <div className="err">{err}</div>}
          <button className="primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="sub" style={{ marginBottom: 0 }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

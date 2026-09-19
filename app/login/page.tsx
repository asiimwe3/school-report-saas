"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/src/lib/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await post<{ csrfSecret: string }>("/api/auth/login", { email, password });
      localStorage.setItem("csrfSecret", res.csrfSecret);
      router.replace("/dashboard");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>
          DeryCode <span style={{ color: "var(--accent2)" }}>School Reports</span>
        </h1>
        <p className="sub">Sign in to your school workspace.</p>
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {err && <div className="err">{err}</div>}
          <button className="primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

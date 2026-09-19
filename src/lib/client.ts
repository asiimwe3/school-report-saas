"use client";
/** API client: JSON fetch with the CSRF token from login. */
export function csrf(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("csrfSecret");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.method && init.method !== "GET") {
    const token = csrf();
    if (token) headers["x-csrf-token"] = token;
  }
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message ?? `Request failed (${res.status})`), {
      code: data?.error?.code,
      status: res.status,
    });
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const get = <T>(path: string) => api<T>(path, { method: "GET" });

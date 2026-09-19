"use client";
import { useEffect, useState } from "react";
import { get } from "./client";

export interface Me {
  user: { id: string };
  schools: { id: string; name: string; role: string; status: string; activeTermId: string | null }[];
}

/** Loads /api/me, keeps the active schoolId in sync with localStorage. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [schoolId, setSchoolId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Me>("/api/me")
      .then((data) => {
        setMe(data);
        const saved = localStorage.getItem("schoolId");
        const pick = data.schools.find((s) => s.id === saved)?.id ?? data.schools[0]?.id ?? "";
        setSchoolId(pick);
        if (pick) localStorage.setItem("schoolId", pick);
      })
      .catch((e) => {
        if (e?.status === 401) window.location.replace("/login");
        else setError(e.message);
      });
  }, []);

  return { me, schoolId, setSchoolId, error };
}

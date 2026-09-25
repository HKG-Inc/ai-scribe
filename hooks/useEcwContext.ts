"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/utils";

export type EcwLaunchContext = {
  patient: { id: string; name: string | null } | null;
  doctor: { id: string; name: string | null } | null;
  encounterId: string | null;
};

// One request per page load: the launch context does not change until eCW launches again.
let pending: Promise<EcwLaunchContext | null> | null = null;

function loadEcwContext(): Promise<EcwLaunchContext | null> {
  pending ??= apiFetch("/api/ecw/context", { cache: "no-store" })
    .then(async (res) => (res.ok ? ((await res.json()) as EcwLaunchContext) : null))
    .catch(() => null)
    .then((ctx) => {
      if (!ctx) pending = null; // not launched from eCW (or failed): allow a later retry
      return ctx;
    });
  return pending;
}

/** Patient and doctor of the current eCW launch, or null when the app was not launched from eCW. */
export function useEcwContext() {
  const [context, setContext] = useState<EcwLaunchContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadEcwContext().then((ctx) => {
      if (!cancelled) setContext(ctx);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return context;
}

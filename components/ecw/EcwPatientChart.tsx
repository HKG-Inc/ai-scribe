"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/utils";
import { CHART_SECTIONS, type ChartRow, type ChartSectionKey } from "@/lib/ecw/chart";

type SectionState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: ChartRow[]; nextPage: string | null; loadingMore: boolean };

type SectionResponse = {
  ok: boolean;
  rows?: ChartRow[];
  nextPage?: string | null;
  error?: { message?: string };
};

const SECTION_KEYS = Object.keys(CHART_SECTIONS) as ChartSectionKey[];

async function fetchSection(key: ChartSectionKey, page?: string): Promise<SectionResponse> {
  const query = page ? `?page=${encodeURIComponent(page)}` : "";
  try {
    const res = await apiFetch(`/api/ecw/patient-data/${key}${query}`, { cache: "no-store" });
    return (await res.json()) as SectionResponse;
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : "Network error" } };
  }
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The launch patient's eCW chart, one tab per section, each loaded on first open. */
export function EcwPatientChart({ patientName }: { patientName: string | null }) {
  const [active, setActive] = useState<ChartSectionKey>(SECTION_KEYS[0]);
  // The first tab starts loading on mount; the others load the first time they are opened.
  const [sections, setSections] = useState<Partial<Record<ChartSectionKey, SectionState>>>({
    [SECTION_KEYS[0]]: { state: "loading" },
  });

  const apply = useCallback((key: ChartSectionKey, data: SectionResponse) => {
    setSections((s) => ({
      ...s,
      [key]: data.ok
        ? { state: "ready", rows: data.rows ?? [], nextPage: data.nextPage ?? null, loadingMore: false }
        : { state: "error", message: data.error?.message ?? "Could not load from eCW" },
    }));
  }, []);

  const load = (key: ChartSectionKey) => {
    setSections((s) => ({ ...s, [key]: { state: "loading" } }));
    void fetchSection(key).then((data) => apply(key, data));
  };

  useEffect(() => {
    void fetchSection(SECTION_KEYS[0]).then((data) => apply(SECTION_KEYS[0], data));
  }, [apply]);

  const openTab = (key: ChartSectionKey) => {
    setActive(key);
    if (!sections[key]) load(key);
  };

  const loadMore = async (key: ChartSectionKey) => {
    const current = sections[key];
    if (current?.state !== "ready" || !current.nextPage) return;
    setSections((s) => ({ ...s, [key]: { ...current, loadingMore: true } }));
    const data = await fetchSection(key, current.nextPage);
    setSections((s) => ({
      ...s,
      [key]: data.ok
        ? {
            state: "ready",
            rows: [...current.rows, ...(data.rows ?? [])],
            nextPage: data.nextPage ?? null,
            loadingMore: false,
          }
        : { ...current, loadingMore: false },
    }));
  };

  return (
    <div className="w-full flex-1 min-h-0 flex flex-col bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] border border-slate-100 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-800 truncate">{patientName ?? "Patient"}</h2>
          <p className="text-xs text-slate-500">From eClinicalWorks</p>
        </div>
        <button
          onClick={() => load(active)}
          disabled={sections[active]?.state === "loading"}
          className="flex items-center gap-1.5 text-xs sm:text-sm text-brand-blue border border-brand-blue rounded-full px-3 h-8 hover:bg-brand-blue hover:text-white transition-colors disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <Tabs value={active} onValueChange={(v) => openTab(v as ChartSectionKey)} className="flex-1 min-h-0 flex flex-col">
        <TabsList className="gap-1.5 sm:gap-2 overflow-x-auto pb-2 -mx-1 px-1">
          {SECTION_KEYS.map((key) => (
            <TabsTrigger key={key} value={key} className="shrink-0 text-xs sm:text-sm px-3 sm:px-4">
              {CHART_SECTIONS[key].label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SECTION_KEYS.map((key) => (
          <TabsContent key={key} value={key} className="flex-1 min-h-0 overflow-y-auto mt-3">
            <SectionBody state={sections[key]} onRetry={() => load(key)} onLoadMore={() => void loadMore(key)} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function SectionBody({
  state,
  onRetry,
  onLoadMore,
}: {
  state: SectionState | undefined;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (!state || state.state === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading from eCW…
      </div>
    );
  }

  if (state.state === "error") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p>{state.message}</p>
          <button onClick={onRetry} className="mt-2 text-rose-700 underline underline-offset-2">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!state.rows.length) {
    return <p className="py-12 text-center text-sm text-slate-500">No records in eCW.</p>;
  }

  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {state.rows.map((row, i) => (
          <li key={row.id || i} className="py-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">{row.title}</p>
              {row.detail && <p className="text-xs text-slate-500 mt-0.5">{row.detail}</p>}
            </div>
            <div className="text-right shrink-0">
              {row.date && <p className="text-xs text-slate-600">{formatDate(row.date)}</p>}
              {row.status && (
                <span className="inline-block mt-1 text-[11px] capitalize rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">
                  {row.status}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {state.nextPage && (
        <div className="flex justify-center pt-3">
          <button
            onClick={onLoadMore}
            disabled={state.loadingMore}
            className="flex items-center gap-1.5 text-sm text-brand-blue hover:underline disabled:opacity-50"
          >
            {state.loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

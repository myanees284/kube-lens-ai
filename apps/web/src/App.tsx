import { useCallback, useEffect, useMemo, useState } from "react";
import type { ListInvestigationsResponse } from "@kube-lens/contracts";
import { HistoryList } from "./components/HistoryList.tsx";
import { InvestigationPanel } from "./components/InvestigationPanel.tsx";
import { QuestionForm } from "./components/QuestionForm.tsx";
import { useInvestigation } from "./hooks/useInvestigation.ts";
import { ApiRequestError, InvestigationClient, type ClusterSummary } from "./lib/api.ts";

type Summary = ListInvestigationsResponse["items"][number];

const client = new InvestigationClient();
const themeKey = "kube-lens-theme";

function readTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function App() {
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [loadingClusters, setLoadingClusters] = useState(true);
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next === "light" ? "light" : "";
    localStorage.setItem(themeKey, next);
    setTheme(next);
  };

  useEffect(() => {
    const controller = new AbortController();
    client
      .clusters()
      .then((body) => {
        if (!controller.signal.aborted) setClusters(body.clusters);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setClusterError(error instanceof ApiRequestError ? error.message : "Clusters could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingClusters(false);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <header>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium tracking-wide text-teal-300">Local Kubernetes troubleshooting</p>
              <h1 className="mt-2 flex items-end text-3xl font-semibold tracking-tight">
                <span>kube-lens-</span>
                <span className="inline-flex items-start text-teal-300">
                  AI
                  <Sparkles />
                </span>
              </h1>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="mt-1 inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Choose a cluster, then ask why a workload is failing.
          </p>
          <ClusterBar
            clusters={clusters}
            loading={loadingClusters}
            error={clusterError}
            selected={selectedCluster}
            onSelect={setSelectedCluster}
          />
        </header>
        {selectedCluster ? <Dashboard cluster={selectedCluster} /> : null}
      </div>
    </main>
  );
}

function Sparkles() {
  return (
    <svg viewBox="0 0 24 24" className="ml-0.5 size-4" aria-hidden="true">
      <path fill="currentColor" d="M14 2.5 15.4 7 20 8.4 15.4 9.8 14 14.2 12.6 9.8 8 8.4 12.6 7z" />
      <path fill="currentColor" d="M6.2 12.2 7 14.6 9.4 15.4 7 16.2 6.2 18.6 5.4 16.2 3 15.4 5.4 14.6z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="currentColor" d="M15.5 3.2a8.8 8.8 0 1 0 5.3 15.4A9 9 0 0 1 15.5 3.2z" />
    </svg>
  );
}

function ClusterBar({
  clusters,
  loading,
  error,
  selected,
  onSelect,
}: {
  clusters: ClusterSummary[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-xs font-medium tracking-wide text-slate-500">Clusters</h2>
      {loading ? <p className="mt-3 text-sm text-slate-400">Checking cluster connections.</p> : null}
      {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
      {!loading && clusters.length === 0 && !error ? (
        <p className="mt-3 text-sm text-slate-400">No clusters were found in the local kubeconfig.</p>
      ) : null}
      <ul className="mt-3 flex flex-wrap gap-2">
        {clusters.map((cluster) => {
          const isSelected = cluster.name === selected;
          return (
            <li key={cluster.name}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(cluster.name)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm ${
                  isSelected ? "border-teal-400 bg-slate-900 text-slate-100" : "border-slate-800 bg-slate-950 text-slate-300"
                }`}
              >
                <span className={`size-2 rounded-full ${cluster.active ? "bg-emerald-400" : "bg-slate-600"}`} aria-hidden="true" />
                <span>{cluster.name}</span>
                <span className="text-xs text-slate-500">{cluster.active ? "Active" : "Unreachable"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Dashboard({ cluster }: { cluster: string }) {
  const [items, setItems] = useState<Summary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const workspace = useMemo(() => cluster, [cluster]);

  const refreshHistory = useCallback(async () => {
    try {
      const page = await client.list();
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof ApiRequestError ? error.message : "History could not be loaded.");
    }
  }, []);

  useEffect(() => {
    setSelectedId(null);
    void refreshHistory();
  }, [workspace, refreshHistory]);

  const view = useInvestigation(client, selectedId, refreshHistory);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.list(nextCursor);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setHistoryError(error instanceof ApiRequestError ? error.message : "Older investigations could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mt-8 border-t border-slate-800 pt-8">
      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-6">
          <QuestionForm
            client={client}
            cluster={cluster}
            onCreated={(investigationId) => {
              setSelectedId(investigationId);
              void refreshHistory();
            }}
          />
          {historyError ? <p className="text-sm text-rose-300">{historyError}</p> : null}
          <HistoryList
            items={items}
            selectedId={selectedId}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onSelect={setSelectedId}
            onLoadMore={() => void loadMore()}
          />
        </div>
        <InvestigationPanel
          client={client}
          investigation={view.investigation}
          events={view.events}
          stream={view.stream}
          streamError={view.streamError}
          loading={view.loading}
          onIngested={(investigation) => {
            view.replaceInvestigation(investigation);
            void refreshHistory();
          }}
        />
      </div>
    </div>
  );
}

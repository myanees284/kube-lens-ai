import { Activity } from "lucide-react";
import { useEffect, useState } from "react";

type HealthState = "checking" | "ok" | "unreachable";

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/healthz", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          setHealth("unreachable");
          return;
        }
        const body: unknown = await response.json();
        const status =
          typeof body === "object" && body !== null && "status" in body ? body.status : undefined;
        setHealth(status === "ok" ? "ok" : "unreachable");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth("unreachable");
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  const healthLabel =
    health === "checking"
      ? "Checking the local API"
      : health === "ok"
        ? "Local API is reachable"
        : "Local API is not reachable";

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
        <p className="text-sm font-medium tracking-wide text-teal-300">Local Kubernetes troubleshooting</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">kube-lens-ai</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-300">
          Ask why a workload is failing. The agent collects read-only cluster evidence, checks prior
          incidents, and shows the source of every root-cause analysis.
        </p>
        <div className="mt-8 inline-flex w-fit items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-200">
          <Activity className="size-4 text-teal-300" aria-hidden="true" />
          <span>{healthLabel}</span>
        </div>
      </div>
    </main>
  );
}

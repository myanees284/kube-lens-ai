import { useEffect, useState } from "react";
import type { InvestigationResponse, KubernetesEvidence } from "@kube-lens/contracts";
import { ApiRequestError, type IncidentDetails, type InvestigationClient } from "../lib/api.ts";
import {
  canIngest,
  displayedStatus,
  elapsedLabel,
  missedEarlierEvents,
  retrievalPresentation,
  sourcePresentation,
  stageLabel,
  timelineText,
  type TimelineEntry,
} from "../lib/present.ts";
import { type StreamState } from "../hooks/useInvestigation.ts";
import { StatusText } from "./HistoryList.tsx";

export function InvestigationPanel({
  client,
  investigation,
  events,
  stream,
  streamError,
  loading,
  onIngested,
}: {
  client: InvestigationClient;
  investigation: InvestigationResponse | null;
  events: TimelineEntry[];
  stream: StreamState;
  streamError: string | null;
  loading: boolean;
  onIngested: (investigation: InvestigationResponse) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!investigation || investigation.completedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [investigation]);

  if (!investigation && !loading) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-800 p-8 text-sm text-slate-400">
        Submit a question or open a recent investigation.
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium text-teal-300">Progress</h2>
          {investigation ? <StatusText status={displayedStatus(investigation.status, events)} /> : null}
          <span className="text-xs text-slate-400">{streamLabel(stream)}</span>
          {investigation ? (
            <span className="text-xs text-slate-400">
              {elapsedLabel(investigation.createdAt, investigation.completedAt, now)}
            </span>
          ) : null}
        </div>
        {investigation ? <p className="mt-3 text-base text-slate-100">{investigation.question}</p> : null}
        {loading && !investigation ? <p className="mt-3 text-sm text-slate-400">Loading the investigation.</p> : null}
        {streamError ? <p className="mt-3 text-sm text-rose-300">{streamError}</p> : null}
        {stream === "reconnecting" ? (
          <p className="mt-3 text-sm text-amber-200">Reconnecting to progress. The latest saved result stays visible.</p>
        ) : null}
        {missedEarlierEvents(events) ? (
          <p className="mt-3 text-sm text-amber-200">Earlier progress events are no longer retained. The saved result is shown below.</p>
        ) : null}
        <ol className="mt-4 space-y-3">
          {events.map((entry) => (
            <li key={entry.event.sequence} className="grid grid-cols-[auto_1fr] gap-3 text-sm">
              <span className="text-xs text-slate-500">{entry.event.sequence}</span>
              <span>
                <span className="text-slate-200">{stageLabel(entry.event.step)}</span>
                <span className="mt-1 block text-slate-400">{timelineText(entry)}</span>
                {entry.event.error ? (
                  <span className="mt-1 block text-rose-300">
                    {entry.event.error.code}: {entry.event.error.safeMessage}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {events.length === 0 && investigation ? (
          <p className="mt-4 text-sm text-slate-400">Current stage: {stageLabel(investigation.currentStage)}.</p>
        ) : null}
      </section>

      {investigation?.error && investigation.status === "failed" ? (
        <section className="rounded-2xl border border-rose-900/70 bg-rose-950/40 p-5">
          <h2 className="text-sm font-medium text-rose-200">Investigation failed</h2>
          <p className="mt-2 text-sm text-rose-100">
            {investigation.error.code}: {investigation.error.safeMessage}
          </p>
        </section>
      ) : null}
      {investigation?.error && investigation.status === "partial" ? (
        <section className="rounded-2xl border border-amber-800 bg-amber-950/30 p-5">
          <h2 className="text-sm font-medium text-amber-200">Partial result</h2>
          <p className="mt-2 text-sm text-amber-100">
            {investigation.error.code}: {investigation.error.safeMessage}
          </p>
        </section>
      ) : null}

      {investigation?.retrieval ? <RetrievalCard investigation={investigation} /> : null}
      {investigation?.evidence ? <EvidenceCard evidence={investigation.evidence} /> : null}
      {investigation?.rca ? <RcaCard investigation={investigation} client={client} /> : null}
      {investigation ? (
        <IngestCard client={client} investigation={investigation} onIngested={onIngested} />
      ) : null}
    </div>
  );
}

function RetrievalCard({ investigation }: { investigation: InvestigationResponse }) {
  if (!investigation.retrieval) return null;
  const presentation = retrievalPresentation(investigation.retrieval.decision);
  return (
    <section className={`rounded-2xl border p-5 ${presentation.unavailable ? "border-amber-800 bg-amber-950/30" : "border-slate-800 bg-slate-900"}`}>
      <h2 className="text-sm font-medium text-teal-300">Knowledge check</h2>
      <p className="mt-2 text-sm text-slate-100">{presentation.title}</p>
      <p className="mt-1 text-sm text-slate-400">{presentation.detail}</p>
      <p className="mt-3 text-xs text-slate-500">
        {investigation.retrieval.incidentIds.length} incident candidates, {investigation.retrieval.documentIds.length} document candidates
      </p>
    </section>
  );
}

function EvidenceCard({ evidence }: { evidence: KubernetesEvidence }) {
  const [source, setSource] = useState<"all" | KubernetesEvidence["observations"][number]["source"]>("all");
  const visible = evidence.observations.filter((observation) => source === "all" || observation.source === source);
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-medium text-teal-300">Evidence</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-200">{evidence.summary}</p>
      <p className="mt-3 text-xs text-slate-400">
        {evidence.collectionStats.pods} pods, {evidence.collectionStats.services} services, {evidence.collectionStats.events} events,{" "}
        {evidence.collectionStats.logLines} log lines
        {evidence.clusterContextLabel ? ` · ${evidence.clusterContextLabel}` : ""}
      </p>
      {evidence.truncated ? <p className="mt-3 text-sm text-amber-200">Collection was truncated at the configured limit.</p> : null}
      {evidence.limitations.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-100">
          {evidence.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {(["all", "pod", "service", "event", "log"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setSource(item)}
            className={`rounded-full px-3 py-1 text-xs ${source === item ? "bg-teal-500 text-[#042f2e]" : "bg-slate-800 text-slate-300"}`}
          >
            {item}
          </button>
        ))}
      </div>
      <ul className="mt-4 space-y-3">
        {visible.map((observation) => (
          <li key={observation.id} id={`observation-${observation.id}`} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
            <div className="flex flex-wrap gap-2 text-xs text-slate-400">
              <span className="font-medium text-teal-200">{observation.id}</span>
              <span>{observation.source}</span>
              {observation.severity ? <span>{observation.severity}</span> : null}
              {observation.resource ? <span>{observation.resource}</span> : null}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{observation.message}</p>
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p className="mt-4 text-sm text-slate-400">No observations in this source.</p> : null}
    </section>
  );
}

function RcaCard({ investigation, client }: { investigation: InvestigationResponse; client: InvestigationClient }) {
  const rca = investigation.rca;
  const [incident, setIncident] = useState<IncidentDetails | null>(null);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  if (!rca) return null;
  const provenance = sourcePresentation(rca.source);

  const openIncident = async (id: string) => {
    setIncidentError(null);
    try {
      setIncident(await client.getIncident(id));
    } catch (error) {
      setIncident(null);
      setIncidentError(error instanceof ApiRequestError ? error.message : "The incident could not be loaded.");
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-medium text-teal-300">Root cause</h2>
      <p className="mt-3 text-sm font-medium text-slate-100">{provenance.title}</p>
      <p className="mt-1 text-sm text-slate-400">{provenance.detail}</p>
      <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">Summary</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-100">{rca.summary}</p>
      <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">Root cause</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-100">{rca.rootCause}</p>
      {rca.reasoning ? (
        <>
          <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">Reasoning</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{rca.reasoning}</p>
        </>
      ) : null}
      <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">Recommendations</h3>
      <ul className="mt-2 space-y-3">
        {rca.recommendations.map((recommendation) => (
          <li key={recommendation.text} className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
            <p className="text-slate-100">{recommendation.text}</p>
            {recommendation.rationale ? <p className="mt-1 text-slate-400">{recommendation.rationale}</p> : null}
            {recommendation.evidenceRefs.length > 0 ? (
              <p className="mt-2 flex flex-wrap gap-2 text-xs">
                {recommendation.evidenceRefs.map((ref) => (
                  <a key={ref} href={`#observation-${ref}`} className="text-teal-300">
                    {ref}
                  </a>
                ))}
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-500">No evidence reference was attached.</p>
            )}
          </li>
        ))}
      </ul>
      {rca.limitations.length > 0 ? (
        <>
          <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">Limitations</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
            {rca.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="mt-4 text-xs font-medium tracking-wide text-slate-500">References</h3>
      <ul className="mt-2 space-y-2">
        {rca.references.map((reference) => (
          <li key={`${reference.type}-${reference.id}`} className="text-sm text-slate-200">
            <span className="text-slate-500">{referenceLabel(reference.type)} · </span>
            {reference.title ?? reference.id}
            {reference.type === "incident" ? (
              <button type="button" onClick={() => void openIncident(reference.id)} className="ml-2 text-teal-300">
                View incident
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {incidentError ? <p className="mt-3 text-sm text-rose-300">{incidentError}</p> : null}
      {incident ? (
        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
          <p className="font-medium text-slate-100">{incident.title}</p>
          <p className="mt-1 text-slate-400">{incident.problemSummary}</p>
          <p className="mt-2 text-slate-300">{incident.rca.summary}</p>
          <p className="mt-2 text-xs text-slate-500">Source: {incident.source.type}</p>
        </div>
      ) : null}
    </section>
  );
}

function IngestCard({
  client,
  investigation,
  onIngested,
}: {
  client: InvestigationClient;
  investigation: InvestigationResponse;
  onIngested: (investigation: InvestigationResponse) => void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = canIngest(investigation);

  const save = async () => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await client.ingest(investigation.investigationId);
      const latest = await client.getInvestigation(investigation.investigationId);
      onIngested(latest);
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : "The knowledge base could not be updated.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-medium text-teal-300">Knowledge base</h2>
      {investigation.ingestion.status === "succeeded" && investigation.ingestion.incidentId ? (
        <p className="mt-2 text-sm text-slate-200">Saved as incident {investigation.ingestion.incidentId}.</p>
      ) : null}
      {investigation.ingestion.status === "failed" ? (
        <p className="mt-2 text-sm text-amber-200">The last save did not complete. The investigation result is still here.</p>
      ) : null}
      {allowed ? (
        <>
          <p className="mt-2 text-sm text-slate-400">Saving is optional. Reusable incident knowledge is written only when you choose it.</p>
          <button
            type="button"
            onClick={() => void save()}
            disabled={pending}
            className="mt-4 rounded-lg border border-teal-500 px-4 py-2 text-sm text-teal-200 disabled:opacity-60"
          >
            {pending ? "Saving" : "Save to knowledge base"}
          </button>
        </>
      ) : investigation.ingestion.status !== "succeeded" ? (
        <p className="mt-2 text-sm text-slate-400">This investigation has no RCA to save.</p>
      ) : null}
      {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}
      {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
    </section>
  );
}

function streamLabel(stream: StreamState): string {
  switch (stream) {
    case "live":
      return "Live progress";
    case "reconnecting":
      return "Reconnecting";
    case "closed":
      return "Progress closed";
    case "unavailable":
      return "Progress unavailable";
    case "idle":
      return "Waiting";
  }
}

function referenceLabel(type: "incident" | "kubernetes_doc" | "observation"): string {
  switch (type) {
    case "incident":
      return "Incident";
    case "kubernetes_doc":
      return "Kubernetes note";
    case "observation":
      return "Observation";
  }
}

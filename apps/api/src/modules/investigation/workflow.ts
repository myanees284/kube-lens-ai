import type { InvestigationScope, KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import { LlmUnavailableError } from "../ai/groq.ts";
import type { PromptDocument } from "../ai/prompt.ts";
import { safeErrorMessage } from "../evidence/sanitize.ts";
import type { InvestigationStatus } from "../persistence/types.ts";
import type { RetrievalDecision, RetrievalStatus } from "../retrieval/decide.ts";
import type { RetrievalOutcome } from "../retrieval/retrieve.ts";
import { buildRetrievalQuery } from "./query.ts";

export interface StoredIncident {
  id: string;
  title: string;
  summary: string;
  details?: string;
  actions: Array<{ text: string; rationale?: string }>;
}

export interface InvestigationStore {
  create(input: { question: string; scope?: InvestigationScope }): Promise<{ id: string }>;
  updateStatus(id: string, update: { status: InvestigationStatus; currentStage: string }): Promise<void>;
  updateStage(id: string, currentStage: string): Promise<void>;
  appendEvent(
    id: string,
    event: {
      eventType: string;
      message: string;
      step?: string;
      status?: string;
      payload?: Record<string, unknown>;
      error?: { code: string; safeMessage: string };
    },
  ): Promise<void>;
  saveResult(
    id: string,
    result: {
      evidence?: KubernetesEvidence;
      retrieval?: {
        status: RetrievalStatus;
        decision: RetrievalDecision;
        incidentIds: string[];
        documentIds: string[];
      };
      rca?: RcaResult;
      error?: { code: string; safeMessage: string } | null;
    },
  ): Promise<void>;
}

export interface InvestigationRunResult {
  id: string;
  status: InvestigationStatus;
  retrievalDecision: RetrievalDecision | null;
  rcaSource: RcaResult["source"] | null;
  errorCode: string | null;
}

export async function runInvestigation(input: {
  existingId?: string;
  question: string;
  scope?: InvestigationScope;
  store: InvestigationStore;
  collect: () => Promise<KubernetesEvidence>;
  retrieve: (query: { queryText: string; observedErrorTokens: string[] }) => Promise<RetrievalOutcome>;
  loadIncident: (id: string) => Promise<StoredIncident | null>;
  loadDocuments: (ids: string[]) => Promise<PromptDocument[]>;
  generateRca: (request: { question: string; evidence: KubernetesEvidence; documents: PromptDocument[] }) => Promise<RcaResult>;
}): Promise<InvestigationRunResult> {
  const id = input.existingId ?? (await input.store.create({ question: input.question, ...(input.scope ? { scope: input.scope } : {}) })).id;
  let evidence: KubernetesEvidence | undefined;
  let retrieval: RetrievalOutcome | undefined;
  let outcome: FinishInput;

  try {
    await input.store.updateStatus(id, { status: "running", currentStage: "collecting_evidence" });
    await input.store.appendEvent(id, { eventType: "investigation.started", status: "running", message: "Investigation started." });
    await begin(input.store, id, "collecting_evidence");
    evidence = await input.collect();
    await end(input.store, id, "collecting_evidence");
    await input.store.updateStage(id, "preparing_evidence");
    await begin(input.store, id, "preparing_evidence");
    await end(input.store, id, "preparing_evidence");
    await input.store.appendEvent(id, {
      eventType: "evidence.summary",
      step: "preparing_evidence",
      status: "completed",
      message: "Evidence summary is ready.",
      payload: { summary: evidence.summary },
    });
    if (evidence.observations.length === 0) {
      outcome = {
        status: "failed",
        evidence,
        error: { code: "INSUFFICIENT_EVIDENCE", safeMessage: "The collected evidence has no observations to analyze." },
      };
    } else {
      await input.store.updateStage(id, "retrieving_knowledge");
      await begin(input.store, id, "retrieving_knowledge");
      retrieval = await retrieveOrFail(input.retrieve, buildRetrievalQuery(input.question, evidence));
      await end(input.store, id, "retrieving_knowledge");
      await input.store.appendEvent(id, {
        eventType: "retrieval.completed",
        step: "retrieving_knowledge",
        status: retrieval.status,
        message: "Retrieval finished.",
        payload: { status: retrieval.status, decision: retrieval.decision },
      });
      const documents = await input.loadDocuments(retrieval.documents.map((document) => document.id));
      const incident = await matchedIncident(input.loadIncident, retrieval);
      if (incident) {
        await input.store.updateStage(id, "using_historical_rca");
        await begin(input.store, id, "using_historical_rca");
        await end(input.store, id, "using_historical_rca");
        await input.store.appendEvent(id, {
          eventType: "rca.completed",
          step: "using_historical_rca",
          status: "completed",
          message: "Stored RCA is ready.",
          payload: { source: "historical_incident" },
        });
        outcome = {
          status: evidence.limitations.length > 0 ? "partial" : "completed",
          evidence,
          retrieval,
          rca: historicalRca(incident, documents),
          error: null,
        };
      } else {
        await input.store.updateStage(id, "generating_rca");
        await begin(input.store, id, "generating_rca");
        await input.store.appendEvent(id, { eventType: "rca.started", step: "generating_rca", status: "running", message: "Groq generation started." });
        const rca = await input.generateRca({ question: input.question, evidence, documents });
        await end(input.store, id, "generating_rca");
        await input.store.appendEvent(id, {
          eventType: "rca.completed",
          step: "generating_rca",
          status: "completed",
          message: "Generated RCA is ready.",
          payload: { source: "groq" },
        });
        const retrievalFailed = retrieval.decision === "retrieval_failed";
        outcome = {
          status: retrievalFailed || evidence.limitations.length > 0 ? "partial" : "completed",
          evidence,
          retrieval,
          rca,
          error: retrievalFailed
            ? { code: "RETRIEVAL_UNAVAILABLE", safeMessage: retrieval.reason ?? "Historical incident knowledge could not be checked." }
            : null,
        };
      }
    }
  } catch (error) {
    outcome = {
      status: "failed",
      ...(evidence ? { evidence } : {}),
      ...(retrieval ? { retrieval } : {}),
      error: { code: failureCode(evidence, error), safeMessage: safeErrorMessage(error) },
    };
  }

  return finish(input.store, id, outcome);
}

async function retrieveOrFail(
  retrieve: (query: { queryText: string; observedErrorTokens: string[] }) => Promise<RetrievalOutcome>,
  query: { queryText: string; observedErrorTokens: string[] },
): Promise<RetrievalOutcome> {
  try {
    return await retrieve(query);
  } catch (error) {
    return {
      status: "unavailable",
      decision: "retrieval_failed",
      incidents: [],
      documents: [],
      reason: safeErrorMessage(error),
    };
  }
}

function historicalRca(incident: StoredIncident, documents: PromptDocument[]): RcaResult {
  return {
    source: "historical_incident",
    summary: incident.summary,
    rootCause: incident.details?.trim() || incident.summary,
    recommendations: incident.actions.map((action) => ({
      text: action.text,
      ...(action.rationale ? { rationale: action.rationale } : {}),
      evidenceRefs: [],
    })),
    limitations: ["This root cause comes from a stored incident. It was not generated for this investigation."],
    references: [
      { type: "incident", id: incident.id, title: incident.title },
      ...documents.map((document) => ({ type: "kubernetes_doc" as const, id: document.id, title: document.title })),
    ],
  };
}

async function matchedIncident(
  loadIncident: (id: string) => Promise<StoredIncident | null>,
  retrieval: RetrievalOutcome,
): Promise<StoredIncident | null> {
  if (retrieval.decision !== "historical_match") return null;
  const incidentId = retrieval.incidents[0]?.id;
  return incidentId ? loadIncident(incidentId) : null;
}

function failureCode(evidence: KubernetesEvidence | undefined, error: unknown): string {
  if (!evidence) return "CLUSTER_UNAVAILABLE";
  return error instanceof LlmUnavailableError ? "LLM_UNAVAILABLE" : "INTERNAL_ERROR";
}

async function begin(store: InvestigationStore, id: string, stage: string): Promise<void> {
  await store.appendEvent(id, { eventType: "step.started", step: stage, status: "started", message: `${stage} started.` });
}

async function end(store: InvestigationStore, id: string, stage: string): Promise<void> {
  await store.appendEvent(id, { eventType: "step.completed", step: stage, status: "completed", message: `${stage} completed.` });
}

interface FinishInput {
  status: "completed" | "partial" | "failed";
  evidence?: KubernetesEvidence;
  retrieval?: RetrievalOutcome;
  rca?: RcaResult;
  error?: { code: string; safeMessage: string } | null;
}

async function finish(
  store: InvestigationStore,
  id: string,
  result: {
    status: "completed" | "partial" | "failed";
    evidence?: KubernetesEvidence;
    retrieval?: RetrievalOutcome;
    rca?: RcaResult;
    error?: { code: string; safeMessage: string } | null;
  },
): Promise<InvestigationRunResult> {
  await store.updateStage(id, "persisting_result");
  await store.saveResult(id, {
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(result.retrieval
      ? {
          retrieval: {
            status: result.retrieval.status,
            decision: result.retrieval.decision,
            incidentIds: result.retrieval.incidents.map((incident) => incident.id),
            documentIds: result.retrieval.documents.map((document) => document.id),
          },
        }
      : {}),
    ...(result.rca ? { rca: result.rca } : {}),
    error: result.error ?? null,
  });
  await store.updateStatus(id, { status: result.status, currentStage: result.status });
  await store.appendEvent(id, {
    eventType: `investigation.${result.status}`,
    status: result.status,
    message: `Investigation ${result.status}.`,
    ...(result.error ? { error: result.error } : {}),
  });
  return {
    id,
    status: result.status,
    retrievalDecision: result.retrieval?.decision ?? null,
    rcaSource: result.rca?.source ?? null,
    errorCode: result.error?.code ?? null,
  };
}

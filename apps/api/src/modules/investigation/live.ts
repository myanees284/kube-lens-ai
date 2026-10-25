import { createHash } from "node:crypto";
import type { InvestigationResponse } from "@kube-lens/contracts";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { createGroqRcaProvider } from "../ai/groq.ts";
import type { AppConfig } from "../../config/env.ts";
import { createLocalEmbeddingProvider, type EmbeddingProvider } from "../embeddings/provider.ts";
import { collectEvidence } from "../evidence/collect.ts";
import { safeErrorMessage } from "../evidence/sanitize.ts";
import { createKubeconfigReader } from "../kubernetes/reader.ts";
import {
  appendInvestigationEvent,
  createInvestigation,
  findIngestedIncident,
  getIncident,
  getInvestigation,
  incidents,
  kubernetesDocs,
  listInvestigations,
  saveInvestigationResult,
  saveIngestedIncident,
  setInvestigationIngestion,
  updateInvestigationStage,
  updateInvestigationStatus,
} from "../persistence/repositories.ts";
import type { InvestigationDocument } from "../persistence/types.ts";
import { prepareIncident } from "../ingestion/prepare.ts";
import { retrieveKnowledge } from "../retrieval/retrieve.ts";
import type { IncidentView, InvestigationApi } from "./api.ts";
import { encodeCursor, type StoredEvent } from "./sse.ts";
import { runInvestigation, type InvestigationStore } from "./workflow.ts";

export function createLiveInvestigationApi(config: AppConfig, db: Db): InvestigationApi {
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  let embeddings: Promise<EmbeddingProvider> | undefined;
  const store = mongoStore(db, config.maxTimelineEvents, (id, event) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
  });

  return {
    async create(input) {
      const created = await createInvestigation(db, input);
      const id = created._id.toHexString();
      void runInvestigation({
        existingId: id,
        question: input.question,
        ...(input.scope ? { scope: input.scope } : {}),
        store,
        collect: async () => {
          const collected = await collectEvidence({
            reader: createKubeconfigReader(input.scope?.context),
            scope: input.scope ?? {},
            defaultNamespace: config.defaultNamespace,
            limits: {
              maxLogLines: config.maxLogLines,
              maxEvents: config.maxEvents,
              maxEvidenceChars: config.maxEvidenceChars,
            },
          });
          return collected.evidence;
        },
        retrieve: async (query) =>
          retrieveKnowledge({
            incidents: incidents(db),
            documents: kubernetesDocs(db),
            embeddings: await embeddingProvider(),
            queryText: query.queryText,
            observedErrorTokens: query.observedErrorTokens,
            candidates: config.ragIncidentCandidates,
            rrfK: config.ragRrfK,
            minScore: config.ragIncidentMinScore,
          }),
        loadIncident: (incidentId) => loadStoredIncident(db, incidentId),
        loadDocuments: (ids) => loadStoredDocuments(db, ids),
        generateRca: (request) =>
          createGroqRcaProvider({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.llmTimeoutMs }).generate(request),
      }).catch((error: unknown) => {
        process.stderr.write(`Investigation ${id} stopped: ${safeErrorMessage(error)}\n`);
      });
      return {
        investigationId: id,
        status: "queued",
        createdAt: created.createdAt.toISOString(),
        links: {
          self: `/api/v1/investigations/${id}`,
          events: `/api/v1/investigations/${id}/events`,
        },
      };
    },
    async get(id) {
      const document = await getInvestigation(db, id);
      return document ? toInvestigationResponse(document) : null;
    },
    async list(input) {
      const documents = await listInvestigations(db, { limit: input.limit + 1, ...(input.before ? { before: input.before } : {}) });
      const page = documents.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map((document) => ({
          investigationId: document._id.toHexString(),
          question: document.question,
          status: document.status,
          ...(document.rca ? { rcaSource: document.rca.source } : {}),
          createdAt: document.createdAt.toISOString(),
        })),
        nextCursor: documents.length > input.limit && last ? encodeCursor(last.createdAt, last._id.toHexString()) : null,
      };
    },
    async openEvents(id) {
      const document = await getInvestigation(db, id);
      if (!document) return null;
      return { status: document.status, events: document.timeline.map(toStoredEvent) };
    },
    subscribe(id, listener) {
      const group = listeners.get(id) ?? new Set();
      group.add(listener);
      listeners.set(id, group);
      return () => group.delete(listener);
    },
    async ingest(id) {
      const document = await getInvestigation(db, id);
      if (!document) return { kind: "missing" };
      const alreadySaved = await findIngestedIncident(db, document._id);
      if (alreadySaved) {
        await setInvestigationIngestion(db, id, { status: "succeeded", incidentId: alreadySaved });
        return { kind: "exists", incidentId: alreadySaved.toHexString() };
      }
      if ((document.status !== "completed" && document.status !== "partial") || !document.rca) {
        return { kind: "conflict", message: "The investigation does not have a usable RCA to save." };
      }
      const prepared = prepareIncident({
        question: document.question,
        ...(document.evidence ? { evidence: document.evidence } : {}),
        rca: document.rca,
        ...(document.scope?.resourceKind ? { resourceKind: document.scope.resourceKind } : {}),
      });
      if (!prepared.ok) return { kind: "conflict", message: prepared.message };
      try {
        const provider = await embeddingProvider();
        const vectors = await provider.embed([prepared.incident.searchText]);
        const embedding = vectors[0];
        if (!embedding || embedding.length !== config.embeddingDimensions) {
          throw new Error("Embedding provider returned a vector that does not match the configured dimensions.");
        }
        const saved = await saveIngestedIncident(db, {
          schemaVersion: 1,
          status: "active",
          title: prepared.incident.title,
          problemSummary: prepared.incident.problemSummary,
          symptoms: prepared.incident.symptoms,
          rca: prepared.incident.rca,
          evidenceSummary: prepared.incident.evidenceSummary,
          source: { type: "investigation_ingestion", investigationId: document._id, ingestedAt: new Date() },
          embedding,
          embeddingModel: provider.modelId(),
          embeddingDimensions: config.embeddingDimensions,
          contentHash: createHash("sha256").update(prepared.incident.searchText).digest("hex"),
        });
        await setInvestigationIngestion(db, id, { status: "succeeded", incidentId: saved.id });
        return { kind: saved.created ? "created" : "exists", incidentId: saved.id.toHexString() };
      } catch (error) {
        await setInvestigationIngestion(db, id, { status: "failed" });
        return { kind: "failed", message: safeErrorMessage(error) };
      }
    },
    async getIncident(id) {
      const document = await getIncident(db, id);
      if (!document) return null;
      return toIncidentView(document);
    },
  };

  function embeddingProvider(): Promise<EmbeddingProvider> {
    embeddings ??= createLocalEmbeddingProvider({ model: config.embeddingModel, dimensions: config.embeddingDimensions });
    return embeddings;
  }
}

function mongoStore(db: Db, maxTimelineEvents: number, publish: (id: string, event: StoredEvent) => void): InvestigationStore {
  return {
    async create(input) {
      const created = await createInvestigation(db, input);
      return { id: created._id.toHexString() };
    },
    updateStatus: (id, update) => updateInvestigationStatus(db, id, update),
    updateStage: (id, stage) => updateInvestigationStage(db, id, stage),
    async appendEvent(id, event) {
      const stored = await appendInvestigationEvent(db, id, event, maxTimelineEvents);
      publish(id, toStoredEvent(stored));
    },
    saveResult: (id, result) => saveInvestigationResult(db, id, result),
  };
}

function toStoredEvent(event: InvestigationDocument["timeline"][number]): StoredEvent {
  return {
    sequence: event.sequence,
    eventType: event.eventType,
    timestamp: event.timestamp.toISOString(),
    message: event.message,
    ...(event.step ? { step: event.step } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function toInvestigationResponse(document: InvestigationDocument): InvestigationResponse {
  return {
    investigationId: document._id.toHexString(),
    status: document.status,
    question: document.question,
    ...(document.currentStage ? { currentStage: document.currentStage } : {}),
    createdAt: document.createdAt.toISOString(),
    ...(document.completedAt ? { completedAt: document.completedAt.toISOString() } : {}),
    ...(document.evidence ? { evidence: document.evidence } : {}),
    ...(document.retrieval
      ? {
          retrieval: {
            status: document.retrieval.status,
            decision: document.retrieval.decision,
            incidentIds: document.retrieval.incidentIds.map((id) => id.toHexString()),
            documentIds: document.retrieval.documentIds.map((id) => id.toHexString()),
          },
        }
      : {}),
    ...(document.rca ? { rca: document.rca } : {}),
    ingestion: {
      status: document.ingestion.status,
      ...(document.ingestion.incidentId ? { incidentId: document.ingestion.incidentId.toHexString() } : {}),
    },
    ...(document.error ? { error: document.error } : {}),
  };
}

function toIncidentView(document: Awaited<ReturnType<typeof getIncident>> & object): IncidentView {
  const incident = document as NonNullable<Awaited<ReturnType<typeof getIncident>>>;
  return {
    incidentId: incident._id.toHexString(),
    title: incident.title,
    problemSummary: incident.problemSummary,
    symptoms: incident.symptoms,
    rca: incident.rca,
    source: {
      type: incident.source.type,
      ...(incident.source.investigationId ? { investigationId: incident.source.investigationId.toHexString() } : {}),
    },
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  };
}

async function loadStoredIncident(db: Db, id: string) {
  const document = await getIncident(db, id);
  if (!document) return null;
  return {
    id: document._id.toHexString(),
    title: document.title,
    summary: document.rca.summary,
    ...(document.rca.details ? { details: document.rca.details } : {}),
    actions: document.rca.recommendedActions,
  };
}

async function loadStoredDocuments(db: Db, ids: string[]) {
  const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (objectIds.length === 0) return [];
  const documents = await kubernetesDocs(db).find({ _id: { $in: objectIds } }).toArray();
  return documents.map((document) => ({
    id: document._id.toHexString(),
    title: document.title,
    sectionPath: document.sectionPath,
    text: document.text,
  }));
}

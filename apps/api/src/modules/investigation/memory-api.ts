import { ObjectId } from "mongodb";
import type { InvestigationResponse, InvestigationScope, KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import type { IncidentView, InvestigationApi } from "./api.ts";
import { encodeCursor, type StoredEvent } from "./sse.ts";

interface MemoryRecord {
  id: string;
  question: string;
  scope?: InvestigationScope;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  currentStage: string;
  createdAt: Date;
  completedAt?: Date;
  evidence?: KubernetesEvidence;
  retrieval?: InvestigationResponseRetrieval;
  rca?: RcaResult;
  ingestion: { status: "not_requested" | "succeeded" | "failed"; incidentId?: string };
  error?: { code: string; safeMessage: string };
  events: StoredEvent[];
}

type InvestigationResponseRetrieval = NonNullable<InvestigationResponse["retrieval"]>;

export interface MemoryInvestigationApi extends InvestigationApi {
  whenIdle(): Promise<void>;
  seed(record: MemoryRecord): void;
}

export function createMemoryInvestigationApi(options?: {
  run?: (record: MemoryRecord, append: (event: Omit<StoredEvent, "sequence" | "timestamp">) => void) => Promise<void>;
}): MemoryInvestigationApi {
  const records = new Map<string, MemoryRecord>();
  const listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  const incidents = new Map<string, IncidentView>();
  const jobs: Array<Promise<void>> = [];

  function append(record: MemoryRecord, event: Omit<StoredEvent, "sequence" | "timestamp">): void {
    const stored: StoredEvent = {
      ...event,
      sequence: (record.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
    };
    record.events.push(stored);
    for (const listener of listeners.get(record.id) ?? []) listener(stored);
  }

  return {
    async create(input) {
      const record: MemoryRecord = {
        id: new ObjectId().toHexString(),
        question: input.question,
        ...(input.scope ? { scope: input.scope } : {}),
        status: "queued",
        currentStage: "accepted",
        createdAt: new Date(),
        ingestion: { status: "not_requested" },
        events: [],
      };
      records.set(record.id, record);
      if (options?.run) {
        const job = options.run(record, (event) => append(record, event)).finally(() => {
          const index = jobs.indexOf(job);
          if (index >= 0) jobs.splice(index, 1);
        });
        jobs.push(job);
      }
      return {
        investigationId: record.id,
        status: "queued",
        createdAt: record.createdAt.toISOString(),
        links: {
          self: `/api/v1/investigations/${record.id}`,
          events: `/api/v1/investigations/${record.id}/events`,
        },
      };
    },
    async get(id) {
      const record = records.get(id);
      return record ? toResponse(record) : null;
    },
    async list(input) {
      const sorted = [...records.values()].sort((left, right) => compareRecords(left, right));
      const filtered = input.before
        ? sorted.filter((record) => compareRecords(record, { createdAt: input.before?.createdAt ?? record.createdAt, id: input.before?.id ?? record.id }) > 0)
        : sorted;
      const page = filtered.slice(0, input.limit + 1);
      const items = page.slice(0, input.limit);
      const last = items.at(-1);
      return {
        items: items.map((record) => ({
          investigationId: record.id,
          question: record.question,
          status: record.status,
          ...(record.rca ? { rcaSource: record.rca.source } : {}),
          createdAt: record.createdAt.toISOString(),
        })),
        nextCursor: page.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
    async openEvents(id) {
      const record = records.get(id);
      return record ? { status: record.status, events: record.events } : null;
    },
    subscribe(id, listener) {
      const group = listeners.get(id) ?? new Set();
      group.add(listener);
      listeners.set(id, group);
      return () => group.delete(listener);
    },
    async ingest(id) {
      const record = records.get(id);
      if (!record) return { kind: "missing" };
      if (record.ingestion.status === "succeeded" && record.ingestion.incidentId) {
        return { kind: "exists", incidentId: record.ingestion.incidentId };
      }
      if ((record.status !== "completed" && record.status !== "partial") || !record.rca) {
        return { kind: "conflict", message: "The investigation does not have a usable RCA to save." };
      }
      const incidentId = new ObjectId().toHexString();
      const now = new Date().toISOString();
      incidents.set(incidentId, {
        incidentId,
        title: record.question,
        problemSummary: record.rca.summary,
        symptoms: { errorTokens: [], logPatterns: [], resourceKinds: [], relevantSignals: [] },
        rca: { summary: record.rca.summary, details: record.rca.rootCause, recommendedActions: record.rca.recommendations.map((item) => ({ text: item.text, ...(item.rationale ? { rationale: item.rationale } : {}) })) },
        source: { type: "investigation_ingestion", investigationId: record.id },
        createdAt: now,
        updatedAt: now,
      });
      record.ingestion = { status: "succeeded", incidentId };
      return { kind: "created", incidentId };
    },
    async getIncident(id) {
      return incidents.get(id) ?? null;
    },
    async whenIdle() {
      await Promise.all([...jobs]);
    },
    seed(record) {
      records.set(record.id, record);
    },
  };
}

function toResponse(record: MemoryRecord): InvestigationResponse {
  return {
    investigationId: record.id,
    status: record.status,
    question: record.question,
    currentStage: record.currentStage,
    createdAt: record.createdAt.toISOString(),
    ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
    ...(record.evidence ? { evidence: record.evidence } : {}),
    ...(record.retrieval ? { retrieval: record.retrieval } : {}),
    ...(record.rca ? { rca: record.rca } : {}),
    ingestion: {
      status: record.ingestion.status,
      ...(record.ingestion.incidentId ? { incidentId: record.ingestion.incidentId } : {}),
    },
    ...(record.error ? { error: record.error } : {}),
  };
}

function compareRecords(left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime();
  if (time !== 0) return time;
  return right.id.localeCompare(left.id);
}

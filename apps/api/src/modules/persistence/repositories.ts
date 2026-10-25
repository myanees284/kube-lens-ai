import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import { ObjectId, type Collection, type Db } from "mongodb";
import { assertStatusTransition } from "../investigation/transitions.ts";
import type { RetrievalDecision, RetrievalStatus } from "../retrieval/decide.ts";
import type { IncidentDocument, InvestigationDocument, InvestigationStatus, KubernetesDocDocument } from "./types.ts";

export const collectionNames = {
  investigations: "investigations",
  incidents: "incidents",
  kubernetesDocs: "kubernetes_docs",
} as const;

export function investigations(db: Db): Collection<InvestigationDocument> {
  return db.collection(collectionNames.investigations);
}

export function incidents(db: Db): Collection<IncidentDocument> {
  return db.collection(collectionNames.incidents);
}

export function kubernetesDocs(db: Db): Collection<KubernetesDocDocument> {
  return db.collection(collectionNames.kubernetesDocs);
}

export async function createInvestigation(
  db: Db,
  input: { question: string; scope?: InvestigationDocument["scope"] },
): Promise<InvestigationDocument> {
  const document: InvestigationDocument = {
    _id: new ObjectId(),
    schemaVersion: 1,
    question: input.question,
    ...(input.scope ? { scope: input.scope } : {}),
    status: "queued",
    currentStage: "accepted",
    createdAt: new Date(),
    timeline: [],
    ingestion: { status: "not_requested" },
  };
  await investigations(db).insertOne(document);
  return document;
}

export async function getInvestigation(db: Db, id: string): Promise<InvestigationDocument | null> {
  if (!ObjectId.isValid(id)) return null;
  return investigations(db).findOne({ _id: new ObjectId(id) });
}

export async function updateInvestigationStatus(
  db: Db,
  id: string,
  update: { status: InvestigationStatus; currentStage?: string },
): Promise<void> {
  const current = await getInvestigation(db, id);
  if (!current) throw new Error("Investigation was not found.");
  assertStatusTransition(current.status, update.status);
  const terminal = update.status === "completed" || update.status === "partial" || update.status === "failed";
  await investigations(db).updateOne(
    { _id: current._id },
    {
      $set: {
        status: update.status,
        ...(update.currentStage ? { currentStage: update.currentStage } : {}),
        ...(update.status === "running" ? { startedAt: new Date() } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
      },
    },
  );
}

export async function updateInvestigationStage(db: Db, id: string, currentStage: string): Promise<void> {
  const current = await getInvestigation(db, id);
  if (!current) throw new Error("Investigation was not found.");
  if (current.status !== "running") throw new Error("Only a running investigation can change stage.");
  await investigations(db).updateOne({ _id: current._id }, { $set: { currentStage } });
}

export async function saveInvestigationResult(
  db: Db,
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
): Promise<void> {
  const current = await getInvestigation(db, id);
  if (!current) throw new Error("Investigation was not found.");
  if (current.status !== "running" && current.status !== "queued") {
    throw new Error("A finished investigation cannot change its result.");
  }
  await investigations(db).updateOne(
    { _id: current._id },
    {
      $set: {
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.retrieval
          ? {
              retrieval: {
                status: result.retrieval.status,
                decision: result.retrieval.decision,
                incidentIds: objectIds(result.retrieval.incidentIds),
                documentIds: objectIds(result.retrieval.documentIds),
              },
            }
          : {}),
        ...(result.rca ? { rca: result.rca } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      ...(result.error === null ? { $unset: { error: "" } } : {}),
    },
  );
}

export async function appendInvestigationEvent(
  db: Db,
  id: string,
  event: {
    eventType: string;
    message: string;
    step?: string;
    status?: string;
    payload?: Record<string, unknown>;
    error?: { code: string; safeMessage: string };
  },
  maxTimelineEvents: number,
): Promise<InvestigationDocument["timeline"][number]> {
  const current = await getInvestigation(db, id);
  if (!current) throw new Error("Investigation was not found.");
  if (current.timeline.length >= maxTimelineEvents) {
    await investigations(db).updateOne({ _id: current._id }, { $pop: { timeline: -1 } });
  }
  const stored: InvestigationDocument["timeline"][number] = {
    sequence: (current.timeline.at(-1)?.sequence ?? 0) + 1,
    eventType: event.eventType,
    timestamp: new Date(),
    message: event.message,
    ...(event.step ? { step: event.step } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
  await investigations(db).updateOne({ _id: current._id }, { $push: { timeline: stored } });
  return stored;
}

export async function listInvestigations(
  db: Db,
  input: { limit: number; before?: { createdAt: Date; id: string } },
): Promise<InvestigationDocument[]> {
  const filter = input.before
    ? {
        $or: [
          { createdAt: { $lt: input.before.createdAt } },
          { createdAt: input.before.createdAt, _id: { $lt: new ObjectId(input.before.id) } },
        ],
      }
    : {};
  return investigations(db)
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(input.limit)
    .toArray();
}

export async function getIncident(db: Db, id: string): Promise<IncidentDocument | null> {
  if (!ObjectId.isValid(id)) return null;
  return incidents(db).findOne({ _id: new ObjectId(id) });
}

export async function setInvestigationIngestion(
  db: Db,
  id: string,
  ingestion: InvestigationDocument["ingestion"],
): Promise<void> {
  const current = await getInvestigation(db, id);
  if (!current) throw new Error("Investigation was not found.");
  await investigations(db).updateOne({ _id: current._id }, { $set: { ingestion } });
}

export async function failInterruptedInvestigations(db: Db): Promise<number> {
  const result = await investigations(db).updateMany(
    { status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: "failed",
        currentStage: "failed",
        completedAt: new Date(),
        error: {
          code: "INTERNAL_ERROR",
          safeMessage: "The investigation was interrupted because the API process restarted.",
        },
      },
    },
  );
  return result.modifiedCount;
}

export async function findIngestedIncident(db: Db, investigationId: ObjectId): Promise<ObjectId | null> {
  const existing = await incidents(db).findOne({ "source.investigationId": investigationId }, { projection: { _id: 1 } });
  return existing?._id ?? null;
}

export async function saveIngestedIncident(
  db: Db,
  input: Omit<IncidentDocument, "_id" | "createdAt" | "updatedAt">,
): Promise<{ id: ObjectId; created: boolean }> {
  const investigationId = input.source.investigationId;
  if (!investigationId) throw new Error("Ingested incident is missing its investigation.");
  const existing = await findIngestedIncident(db, investigationId);
  if (existing) return { id: existing, created: false };
  const now = new Date();
  const document: IncidentDocument = { ...input, _id: new ObjectId(), createdAt: now, updatedAt: now };
  try {
    await incidents(db).insertOne(document);
    return { id: document._id, created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const saved =
      (await findIngestedIncident(db, investigationId)) ??
      (await incidents(db).findOne({ contentHash: input.contentHash }, { projection: { _id: 1 } }))?._id;
    if (saved) return { id: saved, created: false };
    throw error;
  }
}

export async function upsertIncident(
  db: Db,
  input: Omit<IncidentDocument, "_id" | "createdAt" | "updatedAt">,
): Promise<ObjectId> {
  const now = new Date();
  await incidents(db).updateOne(
    { contentHash: input.contentHash },
    { $set: { ...input, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  const saved = await incidents(db).findOne({ contentHash: input.contentHash });
  if (!saved) throw new Error("Incident was not saved.");
  return saved._id;
}

export async function upsertKubernetesDoc(
  db: Db,
  input: Omit<KubernetesDocDocument, "_id" | "createdAt" | "updatedAt">,
): Promise<void> {
  const now = new Date();
  await kubernetesDocs(db).updateOne(
    { contentHash: input.contentHash },
    { $set: { ...input, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

function objectIds(ids: string[]): ObjectId[] {
  return ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

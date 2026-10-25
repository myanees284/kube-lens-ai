import { createHash } from "node:crypto";
import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import { ObjectId } from "mongodb";
import { loadConfig } from "../config/env.ts";
import { createLocalEmbeddingProvider } from "../modules/embeddings/provider.ts";
import { prepareIncident } from "../modules/ingestion/prepare.ts";
import { closeMongoClient, getDatabase } from "../modules/persistence/client.ts";
import { incidents, kubernetesDocs, saveIngestedIncident } from "../modules/persistence/repositories.ts";
import { retrieveKnowledge } from "../modules/retrieval/retrieve.ts";

const config = loadConfig();
const db = getDatabase(config.mongodbUri, config.mongodbDatabase);
const embeddings = await createLocalEmbeddingProvider({
  model: config.embeddingModel,
  dimensions: config.embeddingDimensions,
});

const evidence: KubernetesEvidence = {
  collectedAt: new Date().toISOString(),
  scope: { namespace: "book-prod", resourceKind: "Pod", resourceName: "book-search" },
  observations: [
    {
      id: "E1",
      source: "pod",
      resource: "pod/book-search",
      severity: "error",
      message: "Pod book-search is waiting (CrashLoopBackOff), last termination OOMKilled.",
    },
  ],
  summary: "Phase 6 ingest check.",
  collectionStats: { pods: 1, services: 0, events: 0, logLines: 0 },
  truncated: false,
  limitations: [],
};
const rca: RcaResult = {
  source: "groq",
  summary: "Phase 6 check: the container was OOMKilled.",
  rootCause: "The process used more memory than its limit.",
  recommendations: [{ text: "Raise the memory limit.", evidenceRefs: ["E1"] }],
  limitations: [],
  references: [],
};
const prepared = prepareIncident({
  question: "Phase 6 check: why is book-search OOMKilled?",
  evidence,
  rca,
  resourceKind: "Pod",
});
if (!prepared.ok) throw new Error(prepared.message);

const vectors = await embeddings.embed([prepared.incident.searchText]);
const embedding = vectors[0];
if (!embedding || embedding.length !== config.embeddingDimensions) {
  throw new Error("Embedding provider returned a vector that does not match the configured dimensions.");
}

const investigationId = new ObjectId();
const contentHash = createHash("sha256").update(prepared.incident.searchText).digest("hex");
let failed = false;
try {
  const first = await saveIngestedIncident(db, incidentInput(embedding, investigationId, contentHash));
  const second = await saveIngestedIncident(db, incidentInput(embedding, investigationId, contentHash));
  if (first.created !== true || second.created !== false || !first.id.equals(second.id)) {
    throw new Error("A repeated save created another incident.");
  }
  await waitUntilSearchable(prepared.incident.title);
  const result = await retrieveKnowledge({
    incidents: incidents(db),
    documents: kubernetesDocs(db),
    embeddings,
    queryText: prepared.incident.searchText,
    observedErrorTokens: prepared.incident.symptoms.errorTokens,
    candidates: config.ragIncidentCandidates,
    rrfK: config.ragRrfK,
    minScore: config.ragIncidentMinScore,
  });
  const found = result.incidents.some((item) => item.title === prepared.incident.title);
  if (result.decision !== "historical_match" || !found) {
    throw new Error(`Saved incident was not retrieved. decision=${result.decision}`);
  }
  process.stdout.write(`Ingested incident ${first.id.toHexString()} was retrieved without a duplicate.\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.message : "Ingest check failed."}\n`);
  process.exitCode = 1;
} finally {
  await incidents(db).deleteOne({ contentHash });
  await closeMongoClient();
  if (failed) process.exitCode = 1;
}

function incidentInput(embedding: number[], investigationId: ObjectId, contentHash: string) {
  return {
    schemaVersion: 1 as const,
    status: "active" as const,
    title: prepared.ok ? prepared.incident.title : "",
    problemSummary: prepared.ok ? prepared.incident.problemSummary : "",
    symptoms: prepared.ok ? prepared.incident.symptoms : { errorTokens: [], logPatterns: [], resourceKinds: [], relevantSignals: [] },
    rca: prepared.ok ? prepared.incident.rca : { summary: "", recommendedActions: [] },
    evidenceSummary: prepared.ok ? prepared.incident.evidenceSummary : "",
    source: { type: "investigation_ingestion" as const, investigationId, ingestedAt: new Date() },
    embedding,
    embeddingModel: embeddings.modelId(),
    embeddingDimensions: embeddings.dimensions(),
    contentHash,
  };
}

async function waitUntilSearchable(title: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const hits = await incidents(db)
      .aggregate<{ title: string }>([
        {
          $search: {
            index: "incidents_text",
            text: { query: title, path: ["title", "problemSummary", "rca.summary"] },
          },
        },
        { $limit: 5 },
      ])
      .toArray();
    if (hits.some((hit) => hit.title === title)) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("The saved incident did not become searchable in time.");
}

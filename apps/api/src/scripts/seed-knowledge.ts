import { createHash } from "node:crypto";
import { loadConfig } from "../config/env.ts";
import { createLocalEmbeddingProvider } from "../modules/embeddings/provider.ts";
import { closeMongoClient, getDatabase } from "../modules/persistence/client.ts";
import { incidents, upsertIncident, upsertKubernetesDoc } from "../modules/persistence/repositories.ts";
import { waitForSearchIndexes } from "../modules/persistence/setup.ts";
import { documentSearchText, incidentSearchText, seedDocuments, seedIncidents } from "../modules/retrieval/seed-data.ts";

const config = loadConfig();
const db = getDatabase(config.mongodbUri, config.mongodbDatabase);
const embeddings = await createLocalEmbeddingProvider({
  model: config.embeddingModel,
  dimensions: config.embeddingDimensions,
});
const incidentTexts = seedIncidents.map(incidentSearchText);
const documentTexts = seedDocuments.map(documentSearchText);
const vectors = await embeddings.embed([...incidentTexts, ...documentTexts]);
const incidentVectors = vectors.slice(0, seedIncidents.length);
const documentVectors = vectors.slice(seedIncidents.length);

for (const [index, incident] of seedIncidents.entries()) {
  const embedding = incidentVectors[index];
  if (!embedding) throw new Error(`Missing embedding for incident ${incident.title}.`);
  await upsertIncident(db, {
    schemaVersion: 1,
    status: "active",
    title: incident.title,
    problemSummary: incident.problemSummary,
    symptoms: {
      errorTokens: incident.errorTokens,
      logPatterns: incident.logPatterns,
      resourceKinds: incident.resourceKinds,
      relevantSignals: incident.relevantSignals,
    },
    rca: { summary: incident.rcaSummary, recommendedActions: [{ text: incident.action }] },
    evidenceSummary: incident.evidenceSummary,
    source: { type: "manual" },
    embedding,
    embeddingModel: embeddings.modelId(),
    embeddingDimensions: embeddings.dimensions(),
    contentHash: hash(incidentSearchText(incident)),
  });
}

for (const [index, document] of seedDocuments.entries()) {
  const embedding = documentVectors[index];
  if (!embedding) throw new Error(`Missing embedding for document ${document.title}.`);
  await upsertKubernetesDoc(db, {
    schemaVersion: 1,
    documentId: document.documentId,
    title: document.title,
    sectionPath: document.sectionPath,
    chunkIndex: 0,
    text: document.text,
    keywords: document.keywords,
    resourceKinds: document.resourceKinds,
    active: true,
    embedding,
    embeddingModel: embeddings.modelId(),
    embeddingDimensions: embeddings.dimensions(),
    contentHash: hash(documentSearchText(document)),
  });
}

await waitForSearchIndexes(db);
await waitUntilIncidentsAreSearchable(db);
await closeMongoClient();
process.stdout.write(`Seeded ${seedIncidents.length} incidents and ${seedDocuments.length} documents in ${config.mongodbDatabase}.\n`);

async function waitUntilIncidentsAreSearchable(db: ReturnType<typeof getDatabase>): Promise<void> {
  const expected = seedIncidents.map((incident) => incident.title);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const hits = await incidents(db)
      .aggregate<{ title: string }>([
        {
          $search: {
            index: "incidents_text",
            text: {
              query: "ImagePullBackOff OOMKilled liveness",
              path: ["title", "problemSummary", "symptoms.errorTokens", "rca.summary"],
            },
          },
        },
        { $limit: 10 },
      ])
      .toArray();
    const titles = new Set(hits.map((hit) => hit.title));
    if (expected.every((title) => titles.has(title))) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Seeded incidents were not queryable before the timeout.");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

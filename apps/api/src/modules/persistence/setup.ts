import type { Collection, Db, Document, SearchIndexDescription } from "mongodb";
import type { AppConfig } from "../../config/env.ts";
import { getDatabase } from "./client.ts";
import { collectionNames, incidents, investigations, kubernetesDocs } from "./repositories.ts";

const incidentTextIndex = "incidents_text";
const incidentVectorIndex = "incidents_vector";
const docTextIndex = "kubernetes_docs_text";
const docVectorIndex = "kubernetes_docs_vector";

export async function ensureKnowledgeBase(config: AppConfig): Promise<void> {
  const db = getDatabase(config.mongodbUri, config.mongodbDatabase);
  await db.command({ ping: 1 });
  await ensureCollection(db, collectionNames.investigations, investigationValidator);
  await ensureCollection(db, collectionNames.incidents, incidentValidator(config.embeddingDimensions));
  await ensureCollection(db, collectionNames.kubernetesDocs, docValidator(config.embeddingDimensions));

  await investigations(db).createIndex({ createdAt: -1 });
  await investigations(db).createIndex({ status: 1, createdAt: -1 });
  await incidents(db).createIndex(
    { "source.investigationId": 1 },
    {
      unique: true,
      name: "source_investigation_unique",
      partialFilterExpression: { "source.investigationId": { $exists: true } },
    },
  );
  await incidents(db).createIndex({ contentHash: 1 }, { unique: true, name: "incident_content_hash" });
  await kubernetesDocs(db).createIndex({ contentHash: 1 }, { unique: true, name: "doc_content_hash" });

  await ensureSearchIndex(incidents(db), {
    name: incidentTextIndex,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title: { type: "string" },
          problemSummary: { type: "string" },
          status: { type: "token" },
          symptoms: {
            type: "document",
            fields: {
              errorTokens: { type: "string" },
              logPatterns: { type: "string" },
            },
          },
          rca: { type: "document", fields: { summary: { type: "string" } } },
        },
      },
    },
  });
  await ensureSearchIndex(incidents(db), vectorIndex(incidentVectorIndex, config.embeddingDimensions, ["status", "embeddingModel"]));
  const docText = await ensureSearchIndex(kubernetesDocs(db), {
    name: docTextIndex,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title: { type: "string" },
          sectionPath: { type: "string" },
          keywords: { type: "string" },
          text: { type: "string" },
          active: { type: "boolean" },
        },
      },
    },
  });
  const docVector = await ensureSearchIndex(
    kubernetesDocs(db),
    vectorIndex(docVectorIndex, config.embeddingDimensions, ["active", "embeddingModel"]),
  );
  if (docText === "quota" || docVector === "quota") {
    await kubernetesDocs(db).createIndex(
      { title: "text", sectionPath: "text", keywords: "text", text: "text" },
      { name: "doc_keyword" },
    );
  }
}

export async function waitForSearchIndexes(db: Db, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const incidentReady = await searchIndexesReady(incidents(db), [incidentTextIndex, incidentVectorIndex]);
    const documentNames = await searchIndexNames(kubernetesDocs(db));
    const documentTargets = [docTextIndex, docVectorIndex].filter((name) => documentNames.includes(name));
    const documentReady = documentTargets.length === 0 || (await searchIndexesReady(kubernetesDocs(db), documentTargets));
    if (incidentReady && documentReady) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Atlas Search indexes were not ready before the timeout.");
}

async function searchIndexNames<T extends Document>(collection: Collection<T>): Promise<string[]> {
  const indexes = await collection.listSearchIndexes().toArray();
  return indexes.flatMap((index) => (index.name ? [index.name] : []));
}

async function searchIndexesReady<T extends Document>(collection: Collection<T>, names: string[]): Promise<boolean> {
  const indexes = (await collection.listSearchIndexes().toArray()) as Array<{
    name?: string;
    status?: string;
    queryable?: boolean;
  }>;
  return names.every((name) => indexes.some((index) => index.name === name && (index.status === "READY" || index.queryable === true)));
}

async function ensureCollection(db: Db, name: string, validator: Document): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length > 0) return;
  await db.createCollection(name, { validator, validationLevel: "moderate" });
}

async function ensureSearchIndex<T extends Document>(
  collection: Collection<T>,
  index: SearchIndexDescription,
): Promise<"ready" | "quota"> {
  const existing = await collection.listSearchIndexes().toArray();
  if (existing.some((item) => item.name === index.name)) return "ready";
  try {
    await collection.createSearchIndex(index);
    return "ready";
  } catch (error) {
    if (isSearchQuota(error)) {
      if (index.name === incidentTextIndex || index.name === incidentVectorIndex) {
        throw new Error(
          "Atlas rejected the incident search index because this cluster has reached its search index limit. Incident retrieval needs both incidents_text and incidents_vector.",
          { cause: error },
        );
      }
      return "quota";
    }
    throw error;
  }
}

function isSearchQuota(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 20 && error.message.includes("maximum number of FTS indexes");
}

function vectorIndex(name: string, dimensions: number, filters: string[]): SearchIndexDescription {
  return {
    name,
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: dimensions, similarity: "cosine" },
        ...filters.map((path) => ({ type: "filter", path })),
      ],
    },
  };
}

const investigationValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["schemaVersion", "question", "status", "createdAt", "timeline", "ingestion"],
    properties: {
      schemaVersion: { enum: [1] },
      question: { bsonType: "string" },
      status: { enum: ["queued", "running", "completed", "partial", "failed"] },
      timeline: { bsonType: "array" },
    },
  },
};

function incidentValidator(dimensions: number): Document {
  return {
    $jsonSchema: {
      bsonType: "object",
      required: ["schemaVersion", "status", "title", "problemSummary", "embedding", "embeddingModel", "embeddingDimensions", "contentHash"],
      properties: {
        schemaVersion: { enum: [1] },
        status: { enum: ["active", "inactive"] },
        embeddingDimensions: { enum: [dimensions] },
        embedding: { bsonType: "array", minItems: dimensions, maxItems: dimensions },
      },
    },
  };
}

function docValidator(dimensions: number): Document {
  return {
    $jsonSchema: {
      bsonType: "object",
      required: ["schemaVersion", "documentId", "title", "text", "active", "embedding", "embeddingModel", "embeddingDimensions", "contentHash"],
      properties: {
        schemaVersion: { enum: [1] },
        active: { bsonType: "bool" },
        embeddingDimensions: { enum: [dimensions] },
        embedding: { bsonType: "array", minItems: dimensions, maxItems: dimensions },
      },
    },
  };
}

import type { Document } from "mongodb";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import type { IncidentDocument, KubernetesDocDocument } from "../persistence/types.ts";
import { safeErrorMessage } from "../evidence/sanitize.ts";
import { selectHistoricalIncident, type RetrievalDecision, type RetrievalStatus } from "./decide.ts";
import { reciprocalRankFusion } from "./rrf.ts";

export interface IncidentHit {
  id: string;
  title: string;
  score: number;
  errorTokens: string[];
  problemSummary: string;
}

export interface DocumentHit {
  id: string;
  documentId: string;
  title: string;
  sectionPath: string;
  score: number;
}

export interface RetrievalOutcome {
  status: RetrievalStatus;
  decision: RetrievalDecision;
  incidents: IncidentHit[];
  documents: DocumentHit[];
  reason?: string;
}

interface Ranked<T> {
  document: T;
}

interface Queryable<T> {
  aggregate: (pipeline: Document[]) => { toArray: () => Promise<T[]> };
  find?: (filter: Document) => { toArray: () => Promise<T[]> };
  listSearchIndexes?: () => { toArray: () => Promise<Array<{ name?: string; status?: string; queryable?: boolean }>> };
}

export async function retrieveKnowledge(input: {
  incidents: Queryable<IncidentDocument>;
  documents: Queryable<KubernetesDocDocument>;
  embeddings: EmbeddingProvider;
  queryText: string;
  observedErrorTokens: string[];
  candidates: number;
  rrfK: number;
  minScore: number | null;
}): Promise<RetrievalOutcome> {
  let vector: number[];
  try {
    const vectors = await input.embeddings.embed([input.queryText]);
    const first = vectors[0];
    if (!first) throw new Error("Embedding provider returned no vector.");
    vector = first;
  } catch (error) {
    return unavailable(safeErrorMessage(error));
  }

  try {
    const [incidentKeyword, incidentVector] = await Promise.all([
      input.incidents.aggregate(keywordPipeline("incidents_text", input.queryText, ["title", "problemSummary", "symptoms.errorTokens", "symptoms.logPatterns", "rca.summary"], input.candidates, [{ equals: { path: "status", value: "active" } }])).toArray(),
      input.incidents.aggregate(vectorPipeline("incidents_vector", vector, input.candidates, { status: "active", embeddingModel: input.embeddings.modelId() })).toArray(),
    ]);
    const [docKeyword, docVector] = (await atlasDocumentIndexesReady(input.documents))
      ? await Promise.all([
          input.documents.aggregate(keywordPipeline("kubernetes_docs_text", input.queryText, ["title", "sectionPath", "keywords", "text"], input.candidates, [{ equals: { path: "active", value: true } }])).toArray(),
          input.documents.aggregate(vectorPipeline("kubernetes_docs_vector", vector, input.candidates, { active: true, embeddingModel: input.embeddings.modelId() })).toArray(),
        ])
      : await localDocumentSearch(input.documents, input.queryText, vector, input.embeddings.modelId(), input.candidates);

    const incidentRanks = reciprocalRankFusion(
      [ids(incidentKeyword), ids(incidentVector)],
      input.rrfK,
    );
    const documentRanks = reciprocalRankFusion([ids(docKeyword), ids(docVector)], input.rrfK);
    const incidentHits = fuse(incidentKeyword, incidentVector, incidentRanks).map(toIncidentHit);
    const documentHits = fuse(docKeyword, docVector, documentRanks).map(toDocumentHit);
    const selected = selectHistoricalIncident(incidentHits, input.observedErrorTokens, input.minScore);
    const incidents = selected ? [selected, ...incidentHits.filter((hit) => hit.id !== selected.id)] : incidentHits;
    return {
      status: "completed",
      decision: selected ? "historical_match" : "groq_fallback",
      incidents,
      documents: documentHits,
    };
  } catch (error) {
    return unavailable(safeErrorMessage(error));
  }
}

async function atlasDocumentIndexesReady(documents: Queryable<KubernetesDocDocument>): Promise<boolean> {
  if (!documents.listSearchIndexes) return true;
  const indexes = await documents.listSearchIndexes().toArray();
  const ready = (name: string) => indexes.some((index) => index.name === name && (index.status === "READY" || index.queryable === true));
  return ready("kubernetes_docs_text") && ready("kubernetes_docs_vector");
}

async function localDocumentSearch(
  documents: Queryable<KubernetesDocDocument>,
  queryText: string,
  vector: number[],
  modelId: string,
  limit: number,
): Promise<[KubernetesDocDocument[], KubernetesDocDocument[]]> {
  const keyword = await documents
    .aggregate([
      { $match: { active: true, $text: { $search: queryText } } },
      { $addFields: { textScore: { $meta: "textScore" } } },
      { $sort: { textScore: -1 } },
      { $limit: limit },
    ])
    .toArray();
  if (!documents.find) throw new Error("Document retrieval needs a vector index or a find() fallback.");
  const stored = await documents.find({ active: true, embeddingModel: modelId }).toArray();
  const ranked = stored
    .filter((document) => document.embedding.length === vector.length)
    .map((document) => ({ document, score: cosine(vector, document.embedding) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.document);
  return [keyword, ranked];
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

function unavailable(reason: string): RetrievalOutcome {
  return { status: "unavailable", decision: "retrieval_failed", incidents: [], documents: [], reason };
}

function keywordPipeline(index: string, query: string, paths: string[], limit: number, filter: Document[]): Document[] {
  return [
    {
      $search: {
        index,
        compound: {
          filter,
          must: [{ text: { query, path: paths } }],
        },
      },
    },
    { $limit: limit },
  ];
}

function vectorPipeline(index: string, queryVector: number[], limit: number, filter: Record<string, unknown>): Document[] {
  return [
    {
      $vectorSearch: {
        index,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(limit * 20, 100),
        limit,
        filter,
      },
    },
  ];
}

function ids(documents: Array<{ _id: { toString: () => string } }>): string[] {
  return documents.map((document) => document._id.toString());
}

function fuse<T extends { _id: { toString: () => string } }>(
  keyword: T[],
  vector: T[],
  ranks: Array<{ id: string; score: number }>,
): Array<Ranked<T> & { score: number }> {
  const byId = new Map<string, T>();
  for (const document of [...keyword, ...vector]) byId.set(document._id.toString(), document);
  return ranks.flatMap((rank) => {
    const document = byId.get(rank.id);
    return document ? [{ document, score: rank.score }] : [];
  });
}

function toIncidentHit(hit: { document: IncidentDocument; score: number }): IncidentHit {
  return {
    id: hit.document._id.toString(),
    title: hit.document.title,
    score: hit.score,
    errorTokens: hit.document.symptoms?.errorTokens ?? [],
    problemSummary: hit.document.problemSummary,
  };
}

function toDocumentHit(hit: { document: KubernetesDocDocument; score: number }): DocumentHit {
  return {
    id: hit.document._id.toString(),
    documentId: hit.document.documentId,
    title: hit.document.title,
    sectionPath: hit.document.sectionPath,
    score: hit.score,
  };
}

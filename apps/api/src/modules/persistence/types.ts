import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import type { ObjectId } from "mongodb";

export type InvestigationStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface InvestigationDocument {
  _id: ObjectId;
  schemaVersion: 1;
  question: string;
  scope?: {
    context?: string;
    namespace?: string;
    resourceKind?: string;
    resourceName?: string;
  };
  status: InvestigationStatus;
  currentStage?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  evidence?: KubernetesEvidence;
  retrieval?: {
    status: "completed" | "unavailable";
    decision: "historical_match" | "groq_fallback" | "retrieval_failed";
    incidentIds: ObjectId[];
    documentIds: ObjectId[];
  };
  rca?: RcaResult;
  timeline: Array<{
    sequence: number;
    eventType: string;
    timestamp: Date;
    message: string;
    step?: string;
    status?: string;
    payload?: Record<string, unknown>;
    error?: {
      code: string;
      safeMessage: string;
    };
  }>;
  ingestion: {
    status: "not_requested" | "succeeded" | "failed";
    incidentId?: ObjectId;
  };
  error?: {
    code: string;
    safeMessage: string;
  };
}

export interface IncidentDocument {
  _id: ObjectId;
  schemaVersion: 1;
  status: "active" | "inactive";
  title: string;
  problemSummary: string;
  symptoms: {
    errorTokens: string[];
    logPatterns: string[];
    resourceKinds: string[];
    relevantSignals: string[];
  };
  rca: {
    summary: string;
    details?: string;
    recommendedActions: Array<{ text: string; rationale?: string }>;
  };
  evidenceSummary: string;
  source: {
    type: "manual" | "investigation_ingestion";
    investigationId?: ObjectId;
    ingestedAt?: Date;
  };
  embedding: number[];
  embeddingModel: string;
  embeddingDimensions: number;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KubernetesDocDocument {
  _id: ObjectId;
  schemaVersion: 1;
  documentId: string;
  title: string;
  sourceUri?: string;
  version?: string;
  sectionPath: string;
  chunkIndex: number;
  text: string;
  keywords: string[];
  resourceKinds: string[];
  active: boolean;
  embedding: number[];
  embeddingModel: string;
  embeddingDimensions: number;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

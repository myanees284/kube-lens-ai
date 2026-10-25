import type {
  CreateInvestigationResponse,
  InvestigationResponse,
  InvestigationScope,
  ListInvestigationsResponse,
} from "@kube-lens/contracts";
import type { StoredEvent } from "./sse.ts";

export interface IncidentView {
  incidentId: string;
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
  source: {
    type: "manual" | "investigation_ingestion";
    investigationId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type IngestResult =
  | { kind: "created"; incidentId: string }
  | { kind: "exists"; incidentId: string }
  | { kind: "conflict"; message: string }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

export interface InvestigationApi {
  create(input: { question: string; scope?: InvestigationScope }): Promise<CreateInvestigationResponse>;
  get(id: string): Promise<InvestigationResponse | null>;
  list(input: { limit: number; before?: { createdAt: Date; id: string } }): Promise<ListInvestigationsResponse>;
  openEvents(id: string): Promise<{ status: InvestigationResponse["status"]; events: StoredEvent[] } | null>;
  subscribe(id: string, listener: (event: StoredEvent) => void): () => void;
  ingest(id: string): Promise<IngestResult>;
  getIncident(id: string): Promise<IncidentView | null>;
}

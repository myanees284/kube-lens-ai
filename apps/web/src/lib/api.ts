import { fetchEventSource } from "@microsoft/fetch-event-source";
import type {
  CreateInvestigationRequest,
  CreateInvestigationResponse,
  InvestigationResponse,
  InvestigationSseEvent,
  ListInvestigationsResponse,
} from "@kube-lens/contracts";
import type { TimelineEntry } from "./present.ts";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface IncidentDetails {
  incidentId: string;
  title: string;
  problemSummary: string;
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
}

interface WatchHandlers {
  signal: AbortSignal;
  onEvent: (entry: TimelineEntry) => void;
  onLive: () => void;
  onReconnect: () => void;
}

export interface ClusterSummary {
  name: string;
  cluster: string;
  current: boolean;
  active: boolean;
}

export class InvestigationClient {

  clusters(): Promise<{ clusters: ClusterSummary[] }> {
    return this.send("/api/v1/clusters");
  }

  namespaces(context: string): Promise<{ namespaces: string[] }> {
    return this.send(`/api/v1/clusters/${encodeURIComponent(context)}/namespaces`);
  }

  resourceNames(context: string, namespace: string, kind: string): Promise<{ names: string[] }> {
    const params = new URLSearchParams({ namespace, kind });
    return this.send(`/api/v1/clusters/${encodeURIComponent(context)}/resources?${params.toString()}`);
  }

  list(cursor?: string): Promise<ListInvestigationsResponse> {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return this.send(`/api/v1/investigations?${params.toString()}`);
  }

  create(body: CreateInvestigationRequest): Promise<CreateInvestigationResponse> {
    return this.send("/api/v1/investigations", { method: "POST", body: JSON.stringify(body) });
  }

  getInvestigation(id: string): Promise<InvestigationResponse> {
    return this.send(`/api/v1/investigations/${id}`);
  }

  ingest(id: string): Promise<{ incidentId: string; message: string }> {
    return this.send(`/api/v1/investigations/${id}/ingest`, { method: "POST" });
  }

  getIncident(id: string): Promise<IncidentDetails> {
    return this.send(`/api/v1/knowledge/incidents/${id}`);
  }

  async watch(id: string, handlers: WatchHandlers): Promise<void> {
    await fetchEventSource(`/api/v1/investigations/${id}/events`, {
      method: "GET",
      headers: this.headers(false),
      signal: handlers.signal,
      openWhenHidden: true,
      onopen: async (response) => {
        if (!response.ok) throw await readError(response);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.startsWith("text/event-stream")) {
          throw new ApiRequestError(response.status, "INTERNAL_ERROR", "Progress stream was not available.");
        }
        handlers.onLive();
      },
      onmessage: (message) => {
        const entry = parseTimelineEntry(message.event, message.data);
        if (entry) handlers.onEvent(entry);
      },
      onerror: (error: unknown) => {
        if (handlers.signal.aborted) throw error;
        if (error instanceof ApiRequestError && error.status < 500) throw error;
        handlers.onReconnect();
        return 1000;
      },
    });
  }

  private headers(json: boolean): Record<string, string> {
    return json ? { "Content-Type": "application/json" } : {};
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<T> {
    const hasBody = init.body !== undefined;
    const response = await fetch(path, {
      ...init,
      headers: {
        ...this.headers(hasBody),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw await readError(response);
    return (await response.json()) as T;
  }
}

function parseTimelineEntry(type: string, data: string): TimelineEntry | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isSseEvent(parsed)) return null;
    return { type: type || "message", event: parsed };
  } catch {
    return null;
  }
}

function isSseEvent(value: unknown): value is InvestigationSseEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<InvestigationSseEvent>;
  return event.schemaVersion === 1 && typeof event.investigationId === "string" && typeof event.sequence === "number";
}

async function readError(response: Response): Promise<ApiRequestError> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = body.error;
      if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
        const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
        const message = typeof error.message === "string" ? error.message : "The request failed.";
        return new ApiRequestError(response.status, code, message);
      }
    }
  } catch {
    // The body was not JSON.
  }
  return new ApiRequestError(response.status, "INTERNAL_ERROR", "The request failed.");
}

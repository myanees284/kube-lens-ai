import type { FastifyInstance } from "fastify";
import {
  createInvestigationRequestSchema,
  createInvestigationResponseSchema,
  errorBody,
  ingestInvestigationResponseSchema,
  investigationResponseSchema,
  listInvestigationsResponseSchema,
  type CreateInvestigationRequest,
} from "@kube-lens/contracts";
import type { AppConfig } from "../config/env.ts";
import { ApiError } from "../http/api-error.ts";
import { knownContext, listClusterNamespaces, listClusterResourceNames, listKubeClusters } from "../modules/kubernetes/clusters.ts";
import { resolveCollectionScope } from "../modules/evidence/scope.ts";
import type { InvestigationApi } from "../modules/investigation/api.ts";
import { decodeCursor, formatHeartbeat, formatHistoryGap, formatSse, isTerminalEvent, parseLastEventId, selectReplay, type StoredEvent } from "../modules/investigation/sse.ts";

export function registerInvestigationRoutes(app: FastifyInstance, config: AppConfig, api: InvestigationApi): void {
  app.get("/api/v1/clusters", async () => ({ clusters: await listKubeClusters() }));

  app.get("/api/v1/clusters/:context/namespaces", async (request) => {
    const context = contextParam(request.params);
    return { namespaces: await listClusterNamespaces(context) };
  });

  app.get("/api/v1/clusters/:context/resources", async (request) => {
    const context = contextParam(request.params);
    const query = request.query as { namespace?: unknown; kind?: unknown };
    const namespace = typeof query.namespace === "string" ? query.namespace.trim() : "";
    const kind = query.kind === "Service" ? "Service" : "Pod";
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) {
      throw new ApiError(400, "INVALID_REQUEST", "namespace is required.");
    }
    return { names: await listClusterResourceNames(context, namespace, kind) };
  });

  app.post(
    "/api/v1/investigations",
    { schema: { body: createInvestigationRequestSchema, response: { 202: createInvestigationResponseSchema } } },
    async (request, reply) => {
      const body = request.body as CreateInvestigationRequest;
      try {
        resolveCollectionScope(body.scope ?? {}, config.defaultNamespace);
      } catch (error) {
        throw new ApiError(400, "INVALID_REQUEST", error instanceof Error ? error.message : "A namespace is required.");
      }
      const created = await api.create(body);
      return reply.status(202).send(created);
    },
  );

  app.get(
    "/api/v1/investigations",
    { schema: { response: { 200: listInvestigationsResponseSchema } } },
    async (request) => {
      const query = request.query as { limit?: unknown; cursor?: unknown };
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ApiError(400, "INVALID_REQUEST", "limit must be an integer from 1 to 100.");
      }
      let before: { createdAt: Date; id: string } | undefined;
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== "string") throw new ApiError(400, "INVALID_REQUEST", "The cursor is invalid.");
        const decoded = decodeCursor(query.cursor);
        if (!decoded) throw new ApiError(400, "INVALID_REQUEST", "The cursor is invalid.");
        before = decoded;
      }
      return api.list({ limit, ...(before ? { before } : {}) });
    },
  );

  app.get(
    "/api/v1/investigations/:id",
    { schema: { response: { 200: investigationResponseSchema } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const investigation = await api.get(id);
      if (!investigation) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Investigation was not found.");
      return investigation;
    },
  );

  app.get("/api/v1/investigations/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const opened = await api.openEvents(id);
    if (!opened) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Investigation was not found.");
    const header = request.headers["last-event-id"];
    const lastHeader = Array.isArray(header) ? header[0] : header;
    const lastSequence = parseLastEventId(lastHeader, id);
    const selected = selectReplay(opened.events, lastSequence);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (selected.gap) reply.raw.write(formatHistoryGap());
    for (const event of selected.events) reply.raw.write(formatSse(id, event));
    const replayedTerminal = selected.events.some((event) => isTerminalEvent(event.eventType));
    if (isTerminalStatus(opened.status) && !replayedTerminal) {
      reply.raw.write(formatSse(id, terminalEvent(opened.status, opened.events.at(-1)?.sequence ?? 0)));
    }

    if (replayedTerminal || isTerminalStatus(opened.status)) {
      reply.raw.end();
      return;
    }

    let closed = false;
    const unsubscribe = api.subscribe(id, (event) => {
      if (closed) return;
      reply.raw.write(formatSse(id, event));
      if (isTerminalEvent(event.eventType)) close();
    });
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(formatHeartbeat());
    }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };
    request.raw.on("close", close);
  });

  app.post("/api/v1/investigations/:id/ingest", { schema: { response: { 201: ingestInvestigationResponseSchema, 200: ingestInvestigationResponseSchema } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await api.ingest(id);
    if (result.kind === "missing") throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Investigation was not found.");
    if (result.kind === "conflict") throw new ApiError(409, "INGESTION_CONFLICT", result.message);
    if (result.kind === "failed") throw new ApiError(500, "INGESTION_FAILED", result.message);
    const body = {
      investigationId: id,
      incidentId: result.incidentId,
      status: "succeeded" as const,
      message: result.kind === "exists" ? "Incident knowledge was already saved." : "Incident knowledge saved.",
    };
    return reply.status(result.kind === "created" ? 201 : 200).send(body);
  });

  app.get("/api/v1/knowledge/incidents/:id", async (request) => {
    const { id } = request.params as { id: string };
    const incident = await api.getIncident(id);
    if (!incident) throw new ApiError(404, "INCIDENT_NOT_FOUND", "Incident was not found.");
    return incident;
  });

  app.setNotFoundHandler((request, reply) => {
    if ((request.url.split("?")[0] ?? "").startsWith("/api/")) {
      return reply.status(404).send(errorBody("INVESTIGATION_NOT_FOUND", "The requested resource was not found.", request.id));
    }
    return reply.status(404).send({ message: "Not found.", statusCode: 404 });
  });
}

function contextParam(params: unknown): string {
  const context = typeof params === "object" && params !== null && "context" in params && typeof params.context === "string" ? params.context : "";
  if (!knownContext(context)) throw new ApiError(404, "CLUSTER_UNAVAILABLE", "The cluster was not found in the local kubeconfig.");
  return context;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

function terminalEvent(status: string, lastSequence: number): StoredEvent {
  return {
    sequence: lastSequence + 1,
    eventType: `investigation.${status}`,
    timestamp: new Date().toISOString(),
    status,
    message: `Investigation ${status}.`,
  };
}

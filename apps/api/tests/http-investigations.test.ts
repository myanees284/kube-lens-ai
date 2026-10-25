import { Value } from "@sinclair/typebox/value";
import { investigationResponseSchema, listInvestigationsResponseSchema } from "@kube-lens/contracts";
import { ObjectId } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createMemoryInvestigationApi, type MemoryInvestigationApi } from "../src/modules/investigation/memory-api.ts";
import { sampleRca, testApiKey, testConfig } from "./helpers.ts";

describe("investigation http api", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp(api: MemoryInvestigationApi = createMemoryInvestigationApi()): { app: FastifyInstance; api: MemoryInvestigationApi } {
    const app = buildApp(testConfig(), { enableLogger: false, api });
    apps.push(app);
    return { app, api };
  }

  it("returns 202 before the workflow finishes and then the completed result", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = createMemoryInvestigationApi({
      async run(record, append) {
        await gate;
        record.status = "completed";
        record.currentStage = "completed";
        record.completedAt = new Date();
        record.rca = sampleRca();
        append({ eventType: "investigation.completed", status: "completed", message: "Investigation completed." });
      },
    });
    const { app } = createApp(api);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey, "content-type": "application/json" },
      payload: { question: "Why is book-orders in ImagePullBackOff?", scope: { namespace: "book-prod" } },
    });
    expect(created.statusCode).toBe(202);
    const body = created.json<{ investigationId: string; links: { self: string; events: string } }>();
    expect(body.links.self).toBe(`/api/v1/investigations/${body.investigationId}`);

    const running = await app.inject({
      method: "GET",
      url: `/api/v1/investigations/${body.investigationId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(running.json()).toMatchObject({ status: "queued" });

    release();
    await api.whenIdle();
    const done = await app.inject({
      method: "GET",
      url: `/api/v1/investigations/${body.investigationId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(done.statusCode).toBe(200);
    expect(Value.Check(investigationResponseSchema, done.json())).toBe(true);
    expect(done.json()).toMatchObject({ status: "completed", rca: { source: "groq" }, ingestion: { status: "not_requested" } });

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/investigations/${body.investigationId}/events`,
      headers: { "x-api-key": testApiKey },
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: investigation.completed");
    expect(events.body).toContain(`id: ${body.investigationId}:1`);
  });

  it("replays events after Last-Event-ID and says when older events are gone", async () => {
    const api = createMemoryInvestigationApi();
    const id = new ObjectId().toHexString();
    api.seed({
      id,
      question: "Why is book-orders failing?",
      status: "completed",
      currentStage: "completed",
      createdAt: new Date("2026-10-25T06:00:00.000Z"),
      completedAt: new Date("2026-10-25T06:00:02.000Z"),
      ingestion: { status: "not_requested" },
      rca: sampleRca(),
      events: [
        { sequence: 4, eventType: "retrieval.completed", timestamp: "2026-10-25T06:00:01.000Z", message: "Retrieval finished.", payload: { decision: "groq_fallback" } },
        { sequence: 5, eventType: "investigation.completed", timestamp: "2026-10-25T06:00:02.000Z", status: "completed", message: "Investigation completed." },
      ],
    });
    const { app } = createApp(api);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/investigations/${id}/events`,
      headers: { "x-api-key": testApiKey, "last-event-id": `${id}:1` },
    });

    expect(response.body).toContain("no longer retained");
    expect(response.body).toContain("\"sequence\":4");
    expect(response.body).not.toContain("\"sequence\":1");
    expect(response.body).toContain("event: investigation.completed");
  });

  it("paginates investigation summaries without evidence blobs", async () => {
    const api = createMemoryInvestigationApi();
    const { app } = createApp(api);
    for (const question of ["first", "second", "third"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/investigations",
        headers: { "x-api-key": testApiKey, "content-type": "application/json" },
        payload: { question, scope: { namespace: "book-prod" } },
      });
      expect(response.statusCode).toBe(202);
    }

    const page = await app.inject({
      method: "GET",
      url: "/api/v1/investigations?limit=2",
      headers: { "x-api-key": testApiKey },
    });
    expect(page.statusCode).toBe(200);
    const listed = page.json<{ items: Array<{ question: string }>; nextCursor: string | null }>();
    expect(Value.Check(listInvestigationsResponseSchema, listed)).toBe(true);
    expect(listed.items).toHaveLength(2);
    expect(page.body).not.toContain("observations");
    expect(listed.nextCursor).toBeTruthy();

    const next = await app.inject({
      method: "GET",
      url: `/api/v1/investigations?limit=2&cursor=${listed.nextCursor}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(next.json()).toMatchObject({ items: [{ question: "first" }], nextCursor: null });
  });

  it("rejects a missing namespace, an empty question, and an unknown investigation", async () => {
    const { app } = createApp();
    const missingNamespace = await app.inject({
      method: "POST",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey, "content-type": "application/json" },
      payload: { question: "Why is this failing?" },
    });
    const emptyQuestion = await app.inject({
      method: "POST",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey, "content-type": "application/json" },
      payload: { question: "", scope: { namespace: "book-prod" } },
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/investigations/${new ObjectId().toHexString()}`,
      headers: { "x-api-key": testApiKey },
    });

    expect(missingNamespace.statusCode).toBe(400);
    expect(missingNamespace.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(emptyQuestion.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "INVESTIGATION_NOT_FOUND" } });
  });

  it("saves an RCA once and reads the incident without embeddings", async () => {
    const api = createMemoryInvestigationApi({
      async run(record) {
        record.status = "completed";
        record.currentStage = "completed";
        record.completedAt = new Date();
        record.rca = sampleRca();
      },
    });
    const { app } = createApp(api);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey, "content-type": "application/json" },
      payload: { question: "Why is book-orders in ImagePullBackOff? token=super-secret-value", scope: { namespace: "book-prod" } },
    });
    await api.whenIdle();
    const id = created.json<{ investigationId: string }>().investigationId;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/investigations/${id}/ingest`,
      headers: { "x-api-key": testApiKey },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/investigations/${id}/ingest`,
      headers: { "x-api-key": testApiKey },
    });
    const incidentId = first.json<{ incidentId: string }>().incidentId;
    const incident = await app.inject({
      method: "GET",
      url: `/api/v1/knowledge/incidents/${incidentId}`,
      headers: { "x-api-key": testApiKey },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ incidentId, status: "succeeded" });
    expect(incident.statusCode).toBe(200);
    expect(incident.body).not.toContain("embedding");
    expect(incident.json()).toMatchObject({
      source: { type: "investigation_ingestion", investigationId: id },
      symptoms: { errorTokens: ["ImagePullBackOff"] },
    });
    expect(incident.body).not.toContain("super-secret-value");
  });

  it("rejects ingestion when the investigation has no RCA", async () => {
    const { app } = createApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey, "content-type": "application/json" },
      payload: { question: "Why is book-orders failing?", scope: { namespace: "book-prod" } },
    });
    const id = created.json<{ investigationId: string }>().investigationId;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/investigations/${id}/ingest`,
      headers: { "x-api-key": testApiKey },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "INGESTION_CONFLICT" } });
  });
});

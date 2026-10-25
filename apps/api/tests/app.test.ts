import { Value } from "@sinclair/typebox/value";
import { createInvestigationRequestSchema } from "@kube-lens/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { secretsEqual } from "../src/plugins/api-key.ts";
import { testApiKey, testConfig } from "./helpers.ts";

describe("secretsEqual", () => {
  it("matches equal values and rejects different lengths", () => {
    expect(secretsEqual(testApiKey, testApiKey)).toBe(true);
    expect(secretsEqual("short", testApiKey)).toBe(false);
    expect(secretsEqual(`${testApiKey}x`, testApiKey)).toBe(false);
  });
});

describe("http api", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp(): FastifyInstance {
    const app = buildApp(testConfig(), { enableLogger: false });
    apps.push(app);
    return app;
  }

  it("serves health without authentication or internal details", async () => {
    const response = await createApp().inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.body).not.toMatch(/mongo|groq|api-key|APP_API_KEY/i);
  });

  it("rejects missing and wrong API keys on /api routes", async () => {
    const app = createApp();

    const missing = await app.inject({ method: "GET", url: "/api/v1/investigations" });
    const wrong = await app.inject({
      method: "GET",
      url: "/api/v1/investigations",
      headers: { "x-api-key": "not-the-right-key" },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain(testApiKey);
  });

  it("accepts the configured API key and lists investigations", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/v1/investigations",
      headers: { "x-api-key": testApiKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("returns a not-found envelope for an unknown API route", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/v1/does-not-exist",
      headers: { "x-api-key": testApiKey },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "INVESTIGATION_NOT_FOUND" } });
  });
});

describe("request schemas", () => {
  it("accepts a scoped question and rejects an empty question", () => {
    expect(
      Value.Check(createInvestigationRequestSchema, {
        question: "Why is checkout-api failing?",
        scope: { namespace: "book-prod", resourceKind: "Pod", resourceName: "book-orders" },
      }),
    ).toBe(true);

    expect(Value.Check(createInvestigationRequestSchema, { question: "" })).toBe(false);
    expect(Value.Check(createInvestigationRequestSchema, {})).toBe(false);
  });
});

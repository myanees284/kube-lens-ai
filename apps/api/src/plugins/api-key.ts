import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function secretsEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function registerApiKey(app: FastifyInstance, apiKey: string): void {
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) {
      return;
    }

    const header = request.headers["x-api-key"];
    const provided = typeof header === "string" ? header : undefined;
    if (!provided || !secretsEqual(provided, apiKey)) {
      const error = new Error("Unauthorized.");
      (error as Error & { statusCode: number; code: string }).statusCode = 401;
      (error as Error & { statusCode: number; code: string }).code = "UNAUTHORIZED";
      throw error;
    }
  });
}

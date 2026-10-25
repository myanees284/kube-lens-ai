import type { RcaResult } from "@kube-lens/contracts";
import { loadConfig, type AppConfig } from "../src/config/env.ts";

export const testApiKey = "local-test-api-key-value";

export function validEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    APP_API_KEY: testApiKey,
    MONGODB_URI: "mongodb://127.0.0.1:27017/k8s_KBase",
    GROQ_API_KEY: "test-groq-key-value",
    GROQ_MODEL: "test-model",
    ...overrides,
  };
  return env;
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig(validEnv(overrides));
}

export function sampleRca(): RcaResult {
  return {
    source: "groq",
    summary: "The registry host does not resolve.",
    rootCause: "The image points at a missing registry host.",
    recommendations: [{ text: "Correct the image host.", evidenceRefs: ["E1"] }],
    limitations: [],
    references: [{ type: "observation", id: "E1" }],
  };
}

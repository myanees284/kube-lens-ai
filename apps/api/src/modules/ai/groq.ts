import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import Groq, { APIConnectionTimeoutError, RateLimitError } from "groq-sdk";
import { safeErrorMessage } from "../evidence/sanitize.ts";
import { rcaMessages, type PromptDocument } from "./prompt.ts";
import { validateGroqRca } from "./validate-rca.ts";

export class LlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmUnavailableError";
  }
}

export interface RcaGenerator {
  generate(input: { question: string; evidence: KubernetesEvidence; documents: PromptDocument[] }): Promise<RcaResult>;
}

type ChatMessage = { role: "system" | "user"; content: string };

export async function completeRca(input: {
  complete: (messages: ChatMessage[]) => Promise<string | null>;
  question: string;
  evidence: KubernetesEvidence;
  documents: PromptDocument[];
}): Promise<RcaResult> {
  const observationIds = new Set(input.evidence.observations.map((observation) => observation.id));
  const documentIds = input.documents.map((document) => ({ id: document.id, title: document.title }));
  let repair: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content: string | null;
    try {
      content = await input.complete(rcaMessages({ ...input, repair }));
    } catch (error) {
      throw describeGroqFailure(error);
    }
    const validated = validateGroqRca(content, { observationIds, documentIds });
    if (validated.ok) return validated.rca;
    repair = validated.reason;
  }
  throw new LlmUnavailableError("Groq returned a response that did not match the RCA contract.");
}

export function describeGroqFailure(error: unknown): LlmUnavailableError {
  if (error instanceof LlmUnavailableError) return error;
  if (error instanceof RateLimitError) return new LlmUnavailableError("Groq rate limit was reached.", { cause: error });
  if (error instanceof APIConnectionTimeoutError) return new LlmUnavailableError("Groq timed out.", { cause: error });
  return new LlmUnavailableError(safeErrorMessage(error), { cause: error });
}

export function createGroqRcaProvider(input: { apiKey: string; model: string; timeoutMs: number }): RcaGenerator {
  const client = new Groq({ apiKey: input.apiKey, timeout: input.timeoutMs });
  return {
    async generate(request) {
      return completeRca({
        ...request,
        complete: async (messages) => {
          const response = await client.chat.completions.create({
            model: input.model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages,
          });
          return response.choices[0]?.message.content ?? null;
        },
      });
    },
  };
}

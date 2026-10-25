import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import { sanitizeText } from "../evidence/sanitize.ts";
import { buildRetrievalQuery } from "../investigation/query.ts";

export interface PreparedIncident {
  title: string;
  problemSummary: string;
  evidenceSummary: string;
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
  searchText: string;
}

export function prepareIncident(input: {
  question: string;
  evidence?: KubernetesEvidence;
  rca: RcaResult;
  resourceKind?: string;
}): { ok: true; incident: PreparedIncident } | { ok: false; message: string } {
  const title = clip(sanitizeText(input.question));
  const summary = clip(sanitizeText(input.rca.summary));
  const rootCause = clip(sanitizeText(input.rca.rootCause));
  if (!title || !summary || !rootCause) {
    return { ok: false, message: "The RCA is empty after sanitization." };
  }

  const recommendedActions = input.rca.recommendations.flatMap((item) => {
    const text = clip(sanitizeText(item.text));
    if (!text) return [];
    const rationale = item.rationale ? clip(sanitizeText(item.rationale)) : "";
    return [{ text, ...(rationale ? { rationale } : {}) }];
  });
  const evidenceSummary = clip(sanitizeText(input.evidence?.summary ?? summary));
  const observed = buildRetrievalQuery(title, {
    collectedAt: input.evidence?.collectedAt ?? "2026-10-25T00:00:00.000Z",
    scope: input.evidence?.scope ?? {},
    observations: (input.evidence?.observations ?? []).map((observation) => ({
      ...observation,
      message: sanitizeText(observation.message),
    })),
    summary: evidenceSummary,
    collectionStats: input.evidence?.collectionStats ?? { pods: 0, services: 0, events: 0, logLines: 0 },
    truncated: input.evidence?.truncated ?? false,
    limitations: input.evidence?.limitations ?? [],
  }).observedErrorTokens;

  return {
    ok: true,
    incident: {
      title,
      problemSummary: summary,
      evidenceSummary,
      symptoms: {
        errorTokens: observed,
        logPatterns: [],
        resourceKinds: input.resourceKind ? [clip(sanitizeText(input.resourceKind))].filter((kind) => kind.length > 0) : [],
        relevantSignals: [],
      },
      rca: {
        summary,
        details: rootCause,
        recommendedActions,
      },
      searchText: [title, summary, rootCause].join("\n"),
    },
  };
}

function clip(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

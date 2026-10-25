import type { KubernetesEvidence, RcaResult } from "@kube-lens/contracts";
import { describe, expect, it } from "vitest";
import { prepareIncident } from "../src/modules/ingestion/prepare.ts";
import { selectHistoricalIncident } from "../src/modules/retrieval/decide.ts";

const evidence: KubernetesEvidence = {
  collectedAt: "2026-10-25T11:05:00.000Z",
  scope: { namespace: "book-prod", resourceKind: "Pod", resourceName: "book-search" },
  observations: [
    {
      id: "E1",
      source: "pod",
      resource: "pod/book-search",
      severity: "error",
      message: "Pod book-search is waiting (CrashLoopBackOff), last termination OOMKilled. token=super-secret-value",
    },
  ],
  summary: "Collected 1 pod.",
  collectionStats: { pods: 1, services: 0, events: 0, logLines: 0 },
  truncated: false,
  limitations: [],
};

const rca: RcaResult = {
  source: "groq",
  summary: "The container was OOMKilled.",
  rootCause: "The process used more memory than its limit.",
  recommendations: [{ text: "Raise the memory limit.", evidenceRefs: ["E1"] }],
  limitations: [],
  references: [],
};

describe("prepareIncident", () => {
  it("redacts secrets and keeps the observed failure token", () => {
    const prepared = prepareIncident({
      question: "Why is book-search in CrashLoopBackOff? token=super-secret-value",
      evidence,
      rca,
      resourceKind: "Pod",
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.incident.title).not.toContain("super-secret-value");
    expect(prepared.incident.searchText).not.toContain("super-secret-value");
    expect(prepared.incident.title).toContain("[redacted]");
    expect(prepared.incident.symptoms.errorTokens).toEqual(["CrashLoopBackOff", "OOMKilled"]);
  });

  it("can be retrieved by a later query with the same failure token", () => {
    const prepared = prepareIncident({
      question: "Why is book-search in CrashLoopBackOff?",
      evidence,
      rca,
      resourceKind: "Pod",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const selected = selectHistoricalIncident(
      [
        { id: "liveness", score: 0.03, errorTokens: ["CrashLoopBackOff", "Unhealthy"] },
        { id: "saved", score: 0.02, errorTokens: prepared.incident.symptoms.errorTokens },
      ],
      prepared.incident.symptoms.errorTokens,
      null,
    );

    expect(selected?.id).toBe("saved");
  });
});

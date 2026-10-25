import type { KubernetesEvidence } from "@kube-lens/contracts";
import { describe, expect, it } from "vitest";
import { LlmUnavailableError } from "../src/modules/ai/groq.ts";
import type { PromptDocument } from "../src/modules/ai/prompt.ts";
import { buildRetrievalQuery } from "../src/modules/investigation/query.ts";
import { assertStatusTransition } from "../src/modules/investigation/transitions.ts";
import { runInvestigation, type InvestigationStore, type StoredIncident } from "../src/modules/investigation/workflow.ts";
import type { RetrievalOutcome } from "../src/modules/retrieval/retrieve.ts";

const document: PromptDocument = {
  id: "doc-1",
  title: "ImagePullBackOff",
  sectionPath: "workloads/pods/image-pull",
  text: "ImagePullBackOff means the kubelet is retrying an image pull.",
};

const incident: StoredIncident = {
  id: "incident-1",
  title: "Image pull failed because the registry host does not exist",
  summary: "The image registry host cannot be resolved.",
  details: "DNS cannot resolve the registry host.",
  actions: [{ text: "Correct the image repository host." }],
};

describe("investigation status", () => {
  it("rejects a transition out of a finished investigation", () => {
    expect(() => assertStatusTransition("completed", "running")).toThrow(/cannot change from completed to running/);
  });
});

describe("buildRetrievalQuery", () => {
  it("keeps observed error tokens from the evidence", () => {
    const query = buildRetrievalQuery("Why did this pod stop?", evidence(["The container was OOMKilled."]));
    expect(query.observedErrorTokens).toEqual(["OOMKilled"]);
  });
});

describe("runInvestigation", () => {
  it("returns a stored RCA without calling Groq", async () => {
    const generateCalls: unknown[] = [];
    const { store, record } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-orders in ImagePullBackOff?",
      store,
      collect: async () => evidence(["Pod book-orders is in ImagePullBackOff."]),
      retrieve: async () => retrieval("historical_match"),
      loadIncident: async () => incident,
      loadDocuments: async () => [document],
      generateRca: async (request) => {
        generateCalls.push(request);
        return generated();
      },
    });

    expect(generateCalls).toHaveLength(0);
    expect(result).toMatchObject({ status: "completed", rcaSource: "historical_incident", errorCode: null });
    expect(record()?.rca?.references[0]).toMatchObject({ type: "incident", id: "incident-1" });
    expect(record()?.timeline.join(" ")).toContain("using_historical_rca");
    expect(record()?.timeline.join(" ")).not.toContain("generating_rca");
  });

  it("calls Groq with evidence and reference notes when no historical incident matches", async () => {
    const generateCalls: Array<{ documents: PromptDocument[] }> = [];
    const { store, record } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-search restarting?",
      store,
      collect: async () => evidence(["The container was OOMKilled."]),
      retrieve: async () => retrieval("groq_fallback"),
      loadIncident: async () => incident,
      loadDocuments: async () => [document],
      generateRca: async (request) => {
        generateCalls.push(request);
        return generated();
      },
    });

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.documents[0]?.title).toBe("ImagePullBackOff");
    expect(result).toMatchObject({ status: "completed", rcaSource: "groq", retrievalDecision: "groq_fallback" });
    expect(record()?.rca?.source).toBe("groq");
  });

  it("continues to Groq when retrieval fails and keeps that failure visible", async () => {
    const { store, record } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-orders failing?",
      store,
      collect: async () => evidence(["Pod book-orders is in ImagePullBackOff."]),
      retrieve: async () => {
        throw new Error("search failed token=secret");
      },
      loadIncident: async () => null,
      loadDocuments: async () => [],
      generateRca: async () => generated(),
    });

    expect(result).toMatchObject({
      status: "partial",
      retrievalDecision: "retrieval_failed",
      rcaSource: "groq",
      errorCode: "RETRIEVAL_UNAVAILABLE",
    });
    expect(record()?.error?.safeMessage).not.toContain("secret");
  });

  it("fails closed when Kubernetes collection fails", async () => {
    let generatedCalls = 0;
    const { store } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-orders failing?",
      store,
      collect: async () => {
        throw new Error("cluster unreachable token=secret");
      },
      retrieve: async () => retrieval("groq_fallback"),
      loadIncident: async () => null,
      loadDocuments: async () => [],
      generateRca: async () => {
        generatedCalls += 1;
        return generated();
      },
    });

    expect(generatedCalls).toBe(0);
    expect(result).toMatchObject({ status: "failed", errorCode: "CLUSTER_UNAVAILABLE", rcaSource: null });
  });

  it("does not call Groq when the evidence has no observations", async () => {
    let retrievalCalls = 0;
    const { store } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-orders failing?",
      store,
      collect: async () => evidence([]),
      retrieve: async () => {
        retrievalCalls += 1;
        return retrieval("groq_fallback");
      },
      loadIncident: async () => null,
      loadDocuments: async () => [],
      generateRca: async () => generated(),
    });

    expect(retrievalCalls).toBe(0);
    expect(result).toMatchObject({ status: "failed", errorCode: "INSUFFICIENT_EVIDENCE" });
  });

  it("records Groq failure without inventing an RCA", async () => {
    const { store, record } = memoryStore();
    const result = await runInvestigation({
      question: "Why is book-orders failing?",
      store,
      collect: async () => evidence(["Pod book-orders is in ImagePullBackOff."]),
      retrieve: async () => retrieval("groq_fallback"),
      loadIncident: async () => null,
      loadDocuments: async () => [document],
      generateRca: async () => {
        throw new LlmUnavailableError("Groq timed out.");
      },
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "LLM_UNAVAILABLE", rcaSource: null, retrievalDecision: "groq_fallback" });
    expect(record()?.rca).toBeUndefined();
    expect(record()?.error?.safeMessage).toBe("Groq timed out.");
  });
});

function evidence(messages: string[]): KubernetesEvidence {
  return {
    collectedAt: "2026-10-25T06:00:00.000Z",
    scope: { namespace: "book-prod" },
    observations: messages.map((message, index) => ({
      id: `E${index + 1}`,
      source: "event",
      resource: "pod/book-orders",
      message,
    })),
    summary: messages[0] ?? "No observations.",
    collectionStats: { pods: 1, services: 0, events: messages.length, logLines: 0 },
    truncated: false,
    limitations: [],
  };
}

function retrieval(decision: RetrievalOutcome["decision"]): RetrievalOutcome {
  return {
    status: decision === "retrieval_failed" ? "unavailable" : "completed",
    decision,
    incidents: decision === "historical_match" ? [{ id: "incident-1", title: incident.title, score: 0.05, errorTokens: ["ImagePullBackOff"], problemSummary: incident.summary }] : [],
    documents: [{ id: "doc-1", documentId: "image-pull-backoff", title: document.title, sectionPath: document.sectionPath, score: 0.04 }],
  };
}

function generated() {
  return {
    source: "groq" as const,
    summary: "The image registry host cannot be resolved.",
    rootCause: "The container image points at a registry host that DNS cannot resolve.",
    recommendations: [{ text: "Correct the image repository host.", evidenceRefs: ["E1"] }],
    limitations: [],
    references: [],
  };
}

function memoryStore(): {
  store: InvestigationStore;
  record: () => {
    timeline: string[];
    rca?: { source: string; references: Array<{ type: string; id: string }> };
    error?: { safeMessage: string };
  } | undefined;
} {
  const records = new Map<string, { status: "queued" | "running" | "completed" | "partial" | "failed"; timeline: string[]; rca?: { source: string; references: Array<{ type: string; id: string }> }; error?: { safeMessage: string } }>();
  const store: InvestigationStore = {
    async create() {
      records.set("inv-1", { status: "queued", timeline: [] });
      return { id: "inv-1" };
    },
    async updateStatus(_id, update) {
      const current = records.get("inv-1");
      if (!current) throw new Error("missing");
      assertStatusTransition(current.status, update.status);
      current.status = update.status;
    },
    async updateStage() {},
    async appendEvent(_id, event) {
      records.get("inv-1")?.timeline.push(`${event.eventType} ${event.message}`);
    },
    async saveResult(_id, result) {
      const current = records.get("inv-1");
      if (!current) throw new Error("missing");
      if (result.rca) current.rca = result.rca;
      if (result.error) current.error = { safeMessage: result.error.safeMessage };
    },
  };
  return { store, record: () => records.get("inv-1") };
}

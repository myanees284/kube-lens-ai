import { describe, expect, it } from "vitest";
import { decideIncidentMatch } from "../src/modules/retrieval/decide.ts";
import { reciprocalRankFusion } from "../src/modules/retrieval/rrf.ts";
import { retrieveKnowledge } from "../src/modules/retrieval/retrieve.ts";
import type { EmbeddingProvider } from "../src/modules/embeddings/provider.ts";

describe("reciprocalRankFusion", () => {
  it("ranks a document found by both paths above a single-path document", () => {
    const fused = reciprocalRankFusion(
      [
        ["image", "memory"],
        ["image", "liveness"],
      ],
      60,
    );

    expect(fused[0]?.id).toBe("image");
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });
});

describe("decideIncidentMatch", () => {
  it("does not treat a failed search as no match", () => {
    expect(decideIncidentMatch({ searchFailed: true, score: null, incidentErrorTokens: [], observedErrorTokens: [], minScore: 0.01 })).toEqual({
      status: "unavailable",
      decision: "retrieval_failed",
    });
  });

  it("keeps an uncalibrated threshold from selecting a historical RCA", () => {
    expect(decideIncidentMatch({ searchFailed: false, score: 0.9, incidentErrorTokens: ["OOMKilled"], observedErrorTokens: ["OOMKilled"], minScore: null })).toEqual({
      status: "completed",
      decision: "groq_fallback",
    });
  });

  it("rejects a similar incident whose error tokens conflict", () => {
    expect(
      decideIncidentMatch({
        searchFailed: false,
        score: 0.05,
        incidentErrorTokens: ["ImagePullBackOff"],
        observedErrorTokens: ["OOMKilled"],
        minScore: 0.01,
      }),
    ).toEqual({ status: "completed", decision: "groq_fallback" });
  });

  it("selects a historical incident when the RRF score clears the threshold", () => {
    expect(
      decideIncidentMatch({
        searchFailed: false,
        score: 0.05,
        incidentErrorTokens: ["ImagePullBackOff", "ErrImagePull"],
        observedErrorTokens: ["ErrImagePull"],
        minScore: 0.01,
      }),
    ).toEqual({ status: "completed", decision: "historical_match" });
  });
});

describe("retrieveKnowledge", () => {
  it("returns retrieval_failed when embedding is unavailable", async () => {
    const embeddings: EmbeddingProvider = {
      modelId: () => "all-MiniLM-L6-v2",
      dimensions: () => 384,
      embed: async () => {
        throw new Error("model download failed token=secret");
      },
    };
    const aggregate = () => {
      throw new Error("search should not run");
    };

    const result = await retrieveKnowledge({
      incidents: { aggregate },
      documents: { aggregate },
      embeddings,
      queryText: "ImagePullBackOff",
      observedErrorTokens: ["ImagePullBackOff"],
      candidates: 5,
      rrfK: 60,
      minScore: null,
    });

    expect(result).toMatchObject({ status: "unavailable", decision: "retrieval_failed" });
    expect(result.reason).not.toContain("secret");
  });
});

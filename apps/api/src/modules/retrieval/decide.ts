export type RetrievalStatus = "completed" | "unavailable";
export type RetrievalDecision = "historical_match" | "groq_fallback" | "retrieval_failed";

export function decideIncidentMatch(input: {
  searchFailed: boolean;
  score: number | null;
  incidentErrorTokens: string[];
  observedErrorTokens: string[];
  minScore: number | null;
}): { status: RetrievalStatus; decision: RetrievalDecision } {
  if (input.searchFailed) {
    return { status: "unavailable", decision: "retrieval_failed" };
  }
  if (input.score === null || input.minScore === null || input.score < input.minScore) {
    return { status: "completed", decision: "groq_fallback" };
  }
  if (conflicts(input.incidentErrorTokens, input.observedErrorTokens)) {
    return { status: "completed", decision: "groq_fallback" };
  }
  return { status: "completed", decision: "historical_match" };
}

function conflicts(incidentTokens: string[], observedTokens: string[]): boolean {
  const incident = new Set(incidentTokens.map((token) => token.toLowerCase()));
  const observed = observedTokens.map((token) => token.toLowerCase()).filter((token) => token.length > 0);
  if (incident.size === 0 || observed.length === 0) return false;
  return observed.every((token) => !incident.has(token));
}

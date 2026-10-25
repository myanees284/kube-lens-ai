export type RetrievalStatus = "completed" | "unavailable";
export type RetrievalDecision = "historical_match" | "groq_fallback" | "retrieval_failed";

export interface MatchCandidate {
  id: string;
  score: number;
  errorTokens: string[];
}

const rootCauseTokens = new Set(["oomkilled", "imagepullbackoff", "errimagepull", "createcontainerconfigerror"]);
const symptomTokens = new Set(["unhealthy"]);

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
  const selected = selectHistoricalIncident(
    input.score === null
      ? []
      : [{ id: "top", score: input.score, errorTokens: input.incidentErrorTokens }],
    input.observedErrorTokens,
    input.minScore,
  );
  return {
    status: "completed",
    decision: selected ? "historical_match" : "groq_fallback",
  };
}

export function selectHistoricalIncident<T extends MatchCandidate>(
  incidents: T[],
  observedErrorTokens: string[],
  minScore: number | null,
): T | null {
  const observed = normalize(observedErrorTokens);
  const required = observed.filter((token) => rootCauseTokens.has(token));
  const symptoms = observed.filter((token) => symptomTokens.has(token));
  for (const incident of incidents) {
    const tokens = new Set(normalize(incident.errorTokens));
    if (required.length > 0) {
      if (!required.every((token) => tokens.has(token))) continue;
    } else if (symptoms.length > 0) {
      if (!symptoms.every((token) => tokens.has(token))) continue;
    } else if (minScore === null || incident.score < minScore || conflicts(tokens, observed)) {
      continue;
    }
    if (minScore !== null && incident.score < minScore) continue;
    return incident;
  }
  return null;
}

function conflicts(incidentTokens: Set<string>, observedTokens: string[]): boolean {
  if (incidentTokens.size === 0 || observedTokens.length === 0) return false;
  return observedTokens.every((token) => !incidentTokens.has(token));
}

function normalize(tokens: string[]): string[] {
  return [...new Set(tokens.map((token) => token.toLowerCase()).filter((token) => token.length > 0))];
}

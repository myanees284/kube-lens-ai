import type { KubernetesEvidence } from "@kube-lens/contracts";

const knownErrorTokens = [
  "CreateContainerConfigError",
  "ImagePullBackOff",
  "ErrImagePull",
  "CrashLoopBackOff",
  "OOMKilled",
  "Unhealthy",
];

export function buildRetrievalQuery(question: string, evidence: KubernetesEvidence): {
  queryText: string;
  observedErrorTokens: string[];
} {
  const corpus = [question, ...evidence.observations.map((observation) => `${observation.resource ?? ""} ${observation.message}`)].join("\n");
  const observedErrorTokens = knownErrorTokens.filter((token) => corpus.toLowerCase().includes(token.toLowerCase()));
  const resources = evidence.observations.flatMap((observation) => (observation.resource ? [observation.resource] : []));
  const excerpts = evidence.observations.map((observation) => observation.message).join("\n").slice(0, 4_000);
  const queryText = [question, observedErrorTokens.join(" "), resources.join(" "), excerpts].filter((part) => part.trim()).join("\n");
  return { queryText, observedErrorTokens };
}

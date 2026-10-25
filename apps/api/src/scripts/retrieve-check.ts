import { loadConfig } from "../config/env.ts";
import { createLocalEmbeddingProvider } from "../modules/embeddings/provider.ts";
import { closeMongoClient, getDatabase } from "../modules/persistence/client.ts";
import { incidents, kubernetesDocs } from "../modules/persistence/repositories.ts";
import { retrieveKnowledge } from "../modules/retrieval/retrieve.ts";

const config = loadConfig();
const db = getDatabase(config.mongodbUri, config.mongodbDatabase);
const embeddings = await createLocalEmbeddingProvider({
  model: config.embeddingModel,
  dimensions: config.embeddingDimensions,
});

const checks = [
  {
    label: "image pull",
    queryText: "Why is the pod in ImagePullBackOff because the registry host does not exist?",
    observedErrorTokens: ["ImagePullBackOff", "ErrImagePull"],
    incidentTitle: "Image pull failed because the registry host does not exist",
    documentTitle: "ImagePullBackOff",
  },
  {
    label: "memory",
    queryText: "The container was OOMKilled after it exceeded its memory limit.",
    observedErrorTokens: ["OOMKilled"],
    incidentTitle: "Container exceeded its memory limit",
    documentTitle: "OOMKilled",
  },
];

const failures: string[] = [];
for (const check of checks) {
  const result = await retrieveKnowledge({
    incidents: incidents(db),
    documents: kubernetesDocs(db),
    embeddings,
    queryText: check.queryText,
    observedErrorTokens: check.observedErrorTokens,
    candidates: config.ragIncidentCandidates,
    rrfK: config.ragRrfK,
    minScore: config.ragIncidentMinScore,
  });
  process.stdout.write(
    `${check.label}: status=${result.status} decision=${result.decision} incidents=${result.incidents.map((item) => item.title).join(" | ") || "none"} documents=${result.documents.map((item) => item.title).join(" | ") || "none"}\n`,
  );
  if (result.status !== "completed") failures.push(`${check.label} search failed: ${result.reason ?? "unknown"}`);
  if (!result.incidents.some((item) => item.title === check.incidentTitle)) {
    failures.push(`${check.label} did not retrieve the expected incident.`);
  }
  if (!result.documents.some((item) => item.title === check.documentTitle)) {
    failures.push(`${check.label} did not retrieve the expected document.`);
  }
  if (result.decision === "historical_match") {
    failures.push(`${check.label} selected a historical RCA before the threshold is calibrated.`);
  }
}

await closeMongoClient();
if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}

import type { RcaResult } from "@kube-lens/contracts";

export function validateGroqRca(
  raw: unknown,
  context: { observationIds: Set<string>; documentIds: Array<{ id: string; title: string }> },
): { ok: true; rca: RcaResult } | { ok: false; reason: string } {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "The response was not a JSON object." };
  const record = parsed as Record<string, unknown>;
  const summary = text(record.summary);
  const rootCause = text(record.rootCause);
  if (!summary || !rootCause) return { ok: false, reason: "summary and rootCause must be non-empty strings." };
  if (!Array.isArray(record.recommendations)) return { ok: false, reason: "recommendations must be an array." };
  if (!Array.isArray(record.limitations)) return { ok: false, reason: "limitations must be an array." };

  const limitations = record.limitations.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const cited = new Set<string>();
  let droppedRef = false;
  const recommendations = record.recommendations.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const recommendation = text(entry.text);
    if (!recommendation) return [];
    const evidenceRefs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && context.observationIds.has(ref))
      : [];
    if (Array.isArray(entry.evidenceRefs) && evidenceRefs.length !== entry.evidenceRefs.length) droppedRef = true;
    for (const ref of evidenceRefs) cited.add(ref);
    const rationale = text(entry.rationale);
    return [{ text: recommendation, ...(rationale ? { rationale } : {}), evidenceRefs }];
  });
  if (droppedRef) limitations.push("A recommendation cited an observation that is not in the collected evidence.");

  const reasoning = text(record.reasoning);
  return {
    ok: true,
    rca: {
      source: "groq",
      summary,
      rootCause,
      ...(reasoning ? { reasoning } : {}),
      recommendations,
      limitations,
      references: [
        ...context.documentIds.map((document) => ({ type: "kubernetes_doc" as const, id: document.id, title: document.title })),
        ...[...cited].map((id) => ({ type: "observation" as const, id })),
      ],
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

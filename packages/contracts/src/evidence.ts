import { Type, type Static } from "@sinclair/typebox";

export const observationSourceSchema = Type.Union([
  Type.Literal("pod"),
  Type.Literal("service"),
  Type.Literal("event"),
  Type.Literal("log"),
]);

export const observationSeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("error"),
  Type.Literal("unknown"),
]);

export const investigationScopeSchema = Type.Object({
  namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
  resourceKind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  resourceName: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
});

export const kubernetesEvidenceSchema = Type.Object({
  collectedAt: Type.String({ minLength: 20, maxLength: 40 }),
  clusterContextLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  scope: investigationScopeSchema,
  observations: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 32 }),
      source: observationSourceSchema,
      resource: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      timestamp: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
      severity: Type.Optional(observationSeveritySchema),
      message: Type.String({ minLength: 1 }),
    }),
  ),
  summary: Type.String(),
  collectionStats: Type.Object({
    pods: Type.Integer({ minimum: 0 }),
    services: Type.Integer({ minimum: 0 }),
    events: Type.Integer({ minimum: 0 }),
    logLines: Type.Integer({ minimum: 0 }),
  }),
  truncated: Type.Boolean(),
  limitations: Type.Array(Type.String()),
});

export type InvestigationScope = Static<typeof investigationScopeSchema>;
export type KubernetesEvidence = Static<typeof kubernetesEvidenceSchema>;

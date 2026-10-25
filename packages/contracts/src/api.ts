import { Type, type Static } from "@sinclair/typebox";
import { kubernetesEvidenceSchema, investigationScopeSchema } from "./evidence.js";
import { rcaResultSchema, rcaSourceSchema } from "./rca.js";

export const objectIdSchema = Type.String({ pattern: "^[a-fA-F0-9]{24}$" });

export const investigationStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("partial"),
  Type.Literal("failed"),
]);

export const createInvestigationRequestSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  scope: Type.Optional(investigationScopeSchema),
});

export const createInvestigationResponseSchema = Type.Object({
  investigationId: objectIdSchema,
  status: Type.Literal("queued"),
  createdAt: Type.String({ minLength: 20, maxLength: 40 }),
  links: Type.Object({
    self: Type.String({ minLength: 1 }),
    events: Type.String({ minLength: 1 }),
  }),
});

export const retrievalDecisionSchema = Type.Union([
  Type.Literal("historical_match"),
  Type.Literal("groq_fallback"),
  Type.Literal("retrieval_failed"),
]);

export const investigationResponseSchema = Type.Object({
  investigationId: objectIdSchema,
  status: investigationStatusSchema,
  question: Type.String(),
  currentStage: Type.Optional(Type.String()),
  createdAt: Type.String({ minLength: 20, maxLength: 40 }),
  completedAt: Type.Optional(Type.String({ minLength: 20, maxLength: 40 })),
  evidence: Type.Optional(kubernetesEvidenceSchema),
  retrieval: Type.Optional(
    Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("unavailable")]),
      decision: retrievalDecisionSchema,
      incidentIds: Type.Array(objectIdSchema),
      documentIds: Type.Array(objectIdSchema),
    }),
  ),
  rca: Type.Optional(rcaResultSchema),
  ingestion: Type.Object({
    status: Type.Union([
      Type.Literal("not_requested"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
    ]),
    incidentId: Type.Optional(objectIdSchema),
  }),
  error: Type.Optional(
    Type.Object({
      code: Type.String({ minLength: 1 }),
      safeMessage: Type.String({ minLength: 1 }),
    }),
  ),
});

export const listInvestigationsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

export const investigationSummarySchema = Type.Object({
  investigationId: objectIdSchema,
  question: Type.String(),
  status: investigationStatusSchema,
  rcaSource: Type.Optional(rcaSourceSchema),
  createdAt: Type.String({ minLength: 20, maxLength: 40 }),
});

export const listInvestigationsResponseSchema = Type.Object({
  items: Type.Array(investigationSummarySchema),
  nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});

export const ingestInvestigationResponseSchema = Type.Object({
  investigationId: objectIdSchema,
  incidentId: objectIdSchema,
  status: Type.Literal("succeeded"),
  message: Type.String({ minLength: 1 }),
});

export type CreateInvestigationRequest = Static<typeof createInvestigationRequestSchema>;
export type CreateInvestigationResponse = Static<typeof createInvestigationResponseSchema>;
export type InvestigationResponse = Static<typeof investigationResponseSchema>;
export type ListInvestigationsQuery = Static<typeof listInvestigationsQuerySchema>;
export type ListInvestigationsResponse = Static<typeof listInvestigationsResponseSchema>;

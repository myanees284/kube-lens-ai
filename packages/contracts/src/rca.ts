import { Type, type Static } from "@sinclair/typebox";

export const rcaSourceSchema = Type.Union([
  Type.Literal("historical_incident"),
  Type.Literal("groq"),
]);

export const rcaResultSchema = Type.Object({
  source: rcaSourceSchema,
  summary: Type.String({ minLength: 1 }),
  rootCause: Type.String({ minLength: 1 }),
  reasoning: Type.Optional(Type.String()),
  recommendations: Type.Array(
    Type.Object({
      text: Type.String({ minLength: 1 }),
      rationale: Type.Optional(Type.String()),
      evidenceRefs: Type.Array(Type.String({ minLength: 1 })),
    }),
  ),
  limitations: Type.Array(Type.String()),
  references: Type.Array(
    Type.Object({
      type: Type.Union([
        Type.Literal("incident"),
        Type.Literal("kubernetes_doc"),
        Type.Literal("observation"),
      ]),
      id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String()),
    }),
  ),
});

export type RcaResult = Static<typeof rcaResultSchema>;

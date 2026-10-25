import { Type, type Static } from "@sinclair/typebox";

export const investigationSseEventSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  investigationId: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.String({ minLength: 20, maxLength: 40 }),
  step: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Unknown()),
  error: Type.Optional(
    Type.Object({
      code: Type.String({ minLength: 1 }),
      safeMessage: Type.String({ minLength: 1 }),
    }),
  ),
});

export const sseEventTypes = [
  "investigation.started",
  "step.started",
  "step.completed",
  "evidence.summary",
  "retrieval.completed",
  "rca.started",
  "rca.completed",
  "investigation.completed",
  "investigation.partial",
  "investigation.failed",
] as const;

export type InvestigationSseEvent = Static<typeof investigationSseEventSchema>;
export type SseEventType = (typeof sseEventTypes)[number];

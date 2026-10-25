import { Type, type Static } from "@sinclair/typebox";

export const errorCodes = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "INVESTIGATION_NOT_FOUND",
  "INCIDENT_NOT_FOUND",
  "INGESTION_CONFLICT",
  "CLUSTER_UNAVAILABLE",
  "INSUFFICIENT_EVIDENCE",
  "RETRIEVAL_UNAVAILABLE",
  "LLM_UNAVAILABLE",
  "INGESTION_FAILED",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = Type.Union(
  errorCodes.map((code) => Type.Literal(code)),
);

export const errorResponseSchema = Type.Object({
  error: Type.Object({
    code: errorCodeSchema,
    message: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
  }),
});

export type ErrorCode = (typeof errorCodes)[number];
export type ErrorResponse = Static<typeof errorResponseSchema>;

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}

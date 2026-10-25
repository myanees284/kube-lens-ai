import cors from "@fastify/cors";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { errorBody, errorCodes, healthResponseSchema, type ErrorCode } from "@kube-lens/contracts";
import Fastify, { type FastifyError } from "fastify";
import type { AppConfig } from "./config/env.ts";
import { ApiError } from "./http/api-error.ts";
import type { InvestigationApi } from "./modules/investigation/api.ts";
import { createMemoryInvestigationApi } from "./modules/investigation/memory-api.ts";
import { registerApiKey } from "./plugins/api-key.ts";
import { registerInvestigationRoutes } from "./routes/investigations.ts";

export interface BuildAppOptions {
  enableLogger?: boolean;
  api?: InvestigationApi;
}

export function buildApp(config: AppConfig, options: BuildAppOptions = {}) {
  const app = Fastify({
    logger:
      options.enableLogger === false
        ? false
        : {
            level: config.logLevel,
            redact: ["req.headers.x-api-key", "req.headers.authorization"],
          },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }

    if (error.validation) {
      return reply
        .status(400)
        .send(errorBody("INVALID_REQUEST", "Request failed validation.", request.id));
    }

    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(errorBody(error.code, error.message, request.id));
    }

    if (statusCode === 401 || error.code === "UNAUTHORIZED") {
      return reply.status(401).send(errorBody("UNAUTHORIZED", "Unauthorized.", request.id));
    }

    if (isErrorCode(error.code) && safeClientStatus(statusCode)) {
      return reply.status(statusCode).send(errorBody(error.code, error.message, request.id));
    }

    const safeStatus = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply.status(safeStatus).send(
      errorBody(
        "INTERNAL_ERROR",
        safeStatus === 500 ? "Unexpected error." : "Request could not be completed.",
        request.id,
      ),
    );
  });

  void app.register(cors, {
    origin: config.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
  });

  registerApiKey(app, config.appApiKey);
  registerInvestigationRoutes(app, config, options.api ?? createMemoryInvestigationApi());

  app.get(
    "/healthz",
    {
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  return app;
}

function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && errorCodes.includes(code as ErrorCode);
}

function safeClientStatus(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500;
}

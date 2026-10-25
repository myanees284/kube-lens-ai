export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  appHost: string;
  appPort: number;
  appApiKey: string;
  frontendOrigin: string;
  mongodbUri: string;
  mongodbDatabase: string;
  groqApiKey: string;
  groqModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  defaultNamespace: string | null;
  maxLogLines: number;
  maxEvents: number;
  maxEvidenceChars: number;
  maxTimelineEvents: number;
  ragIncidentCandidates: number;
  ragRrfK: number;
  ragIncidentMinScore: number | null;
  llmTimeoutMs: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const logLevels = new Set<LogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const placeholderPrefix = "replace-with-";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const appApiKey = requiredValue(env, "APP_API_KEY", problems, { minLength: 16 });
  const mongodbUri = requiredValue(env, "MONGODB_URI", problems, { minLength: 1 });
  const groqApiKey = requiredValue(env, "GROQ_API_KEY", problems, { minLength: 1 });
  const groqModel = requiredValue(env, "GROQ_MODEL", problems, { minLength: 1 });

  if (mongodbUri && !/^mongodb(\+srv)?:\/\//.test(mongodbUri)) {
    problems.push(
      "MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string. The value was not printed.",
    );
  }

  const frontendOrigin = optionalString(env, "FRONTEND_ORIGIN") ?? "http://127.0.0.1:5173";
  if (!isOrigin(frontendOrigin)) {
    problems.push(
      "FRONTEND_ORIGIN must be an absolute http(s) origin without a path, for example http://127.0.0.1:5173.",
    );
  }

  const embeddingModel = optionalString(env, "EMBEDDING_MODEL") ?? "all-MiniLM-L6-v2";
  const mongodbDatabase = optionalString(env, "MONGODB_DATABASE") ?? "k8s_KBase";
  const defaultNamespace = optionalString(env, "DEFAULT_NAMESPACE");

  const config: AppConfig = {
    appHost: optionalString(env, "APP_HOST") ?? "127.0.0.1",
    appPort: integerEnv(env, "APP_PORT", 3001, 1, 65535, problems),
    appApiKey,
    frontendOrigin,
    mongodbUri,
    mongodbDatabase,
    groqApiKey,
    groqModel,
    embeddingModel,
    embeddingDimensions: integerEnv(env, "EMBEDDING_DIMENSIONS", 384, 1, 4096, problems),
    defaultNamespace,
    maxLogLines: integerEnv(env, "MAX_LOG_LINES", 200, 1, 5000, problems),
    maxEvents: integerEnv(env, "MAX_EVENTS", 100, 1, 5000, problems),
    maxEvidenceChars: integerEnv(env, "MAX_EVIDENCE_CHARS", 20_000, 1000, 200_000, problems),
    maxTimelineEvents: integerEnv(env, "MAX_TIMELINE_EVENTS", 100, 10, 1000, problems),
    ragIncidentCandidates: integerEnv(env, "RAG_INCIDENT_CANDIDATES", 5, 1, 50, problems),
    ragRrfK: integerEnv(env, "RAG_RRF_K", 60, 1, 1000, problems),
    ragIncidentMinScore: optionalNumber(env, "RAG_INCIDENT_MIN_SCORE", 0, 1_000_000, problems),
    llmTimeoutMs: integerEnv(env, "LLM_TIMEOUT_MS", 30_000, 1000, 120_000, problems),
    logLevel: logLevelEnv(env, problems),
  };

  if (problems.length > 0) {
    throw new ConfigError(
      ["Configuration is invalid.", ...problems.map((problem) => `- ${problem}`)].join("\n"),
    );
  }

  return config;
}

function requiredValue(
  env: NodeJS.ProcessEnv,
  name: string,
  problems: string[],
  options: { minLength: number },
): string {
  const value = optionalString(env, name);
  if (!value) {
    problems.push(`${name} is required. Set it in .env. See .env.example for the name only.`);
    return "";
  }
  if (value.startsWith(placeholderPrefix)) {
    problems.push(`${name} is still the placeholder from .env.example. Replace it with a local value.`);
    return "";
  }
  if (value.length < options.minLength) {
    problems.push(`${name} must be at least ${options.minLength} characters.`);
    return "";
  }
  return value;
}

function optionalString(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined) {
    return null;
  }
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = optionalString(env, name);
  if (raw === null) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be an integer. Received "${raw}".`);
    return fallback;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}. Received ${value}.`);
    return fallback;
  }
  return value;
}

function optionalNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  problems: string[],
): number | null {
  const raw = optionalString(env, name);
  if (raw === null) {
    return null;
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    problems.push(`${name} must be a number. Received "${raw}".`);
    return null;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}. Received ${value}.`);
    return null;
  }
  return value;
}

function logLevelEnv(env: NodeJS.ProcessEnv, problems: string[]): LogLevel {
  const raw = optionalString(env, "LOG_LEVEL");
  if (raw === null) {
    return "info";
  }
  if (!logLevels.has(raw as LogLevel)) {
    problems.push('LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent.');
    return "info";
  }
  return raw as LogLevel;
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

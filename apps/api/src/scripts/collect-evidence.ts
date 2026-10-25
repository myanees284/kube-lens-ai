import { createKubeconfigReader } from "../modules/kubernetes/reader.ts";
import { collectEvidence } from "../modules/evidence/collect.ts";
import { ScopeError } from "../modules/evidence/scope.ts";

const namespace = readArg("--namespace");
const check = process.argv.includes("--check");

if (!namespace) {
  process.stderr.write(
    "A namespace is required. Example: pnpm --filter @kube-lens/api collect-evidence -- --namespace book-prod\n",
  );
  process.exit(1);
}

try {
  const result = await collectEvidence({
    reader: createKubeconfigReader(),
    scope: { namespace },
    defaultNamespace: null,
    limits: {
      maxLogLines: integerEnv("MAX_LOG_LINES", 200),
      maxEvents: integerEnv("MAX_EVENTS", 100),
      maxEvidenceChars: integerEnv("MAX_EVIDENCE_CHARS", 20_000),
    },
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (check) {
    const problems = checkBookProd(result.evidence.observations.map((observation) => observation.message).join("\n"));
    if (problems.length > 0) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exit(1);
    }
  }
} catch (error) {
  const message = error instanceof ScopeError || error instanceof Error ? error.message : "Evidence collection failed.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function checkBookProd(text: string): string[] {
  const expectations: Array<[string, RegExp]> = [
    ["book-catalog running", /Pod book-catalog is Running/],
    ["book-orders image pull failure", /book-orders[\s\S]{0,400}(ImagePull|ErrImagePull)/],
    ["book-payments liveness failure", /book-payments[\s\S]{0,500}(Liveness|CrashLoop|Unhealthy)/],
    ["book-search memory failure", /book-search[\s\S]{0,400}OOMKilled/],
  ];
  return expectations.filter(([, pattern]) => !pattern.test(text)).map(([label]) => `Missing expected evidence: ${label}.`);
}

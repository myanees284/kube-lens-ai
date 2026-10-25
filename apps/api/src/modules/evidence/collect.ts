import { Value } from "@sinclair/typebox/value";
import { kubernetesEvidenceSchema, type InvestigationScope, type KubernetesEvidence } from "@kube-lens/contracts";
import type { ClusterReader, EventSnapshot, LogExcerpt, PodSnapshot, ServiceSnapshot } from "../kubernetes/types.ts";
import { prepareEvidence } from "./prepare.ts";
import { safeErrorMessage } from "./sanitize.ts";
import { resolveCollectionScope, type ResolvedScope } from "./scope.ts";

export interface EvidenceLimits {
  maxLogLines: number;
  maxEvents: number;
  maxEvidenceChars: number;
}

export interface EvidenceCollectionResult {
  evidence: KubernetesEvidence;
  partial: boolean;
}

const linesPerLog = 40;

export async function collectEvidence(input: {
  reader: ClusterReader;
  scope: InvestigationScope;
  defaultNamespace: string | null;
  limits: EvidenceLimits;
  now?: Date;
}): Promise<EvidenceCollectionResult> {
  const scope = resolveCollectionScope(input.scope, input.defaultNamespace);
  const limitations: string[] = [];
  let truncated = false;
  let partial = false;

  const podsResult = await readSource("Pod list", () => input.reader.listPods(scope.namespace));
  const servicesResult = await readSource("Service list", () => input.reader.listServices(scope.namespace));
  const eventsResult = await readSource("Event list", () => input.reader.listEvents(scope.namespace));

  for (const result of [podsResult, servicesResult, eventsResult]) {
    if (result.error) {
      partial = true;
      limitations.push(result.error);
    }
  }

  const pods = selectPods(podsResult.value ?? [], servicesResult.value ?? [], scope);
  const services = selectServices(servicesResult.value ?? [], pods, scope);
  const events = selectEvents(eventsResult.value ?? [], pods, services, scope, input.limits.maxEvents);
  if ((eventsResult.value?.length ?? 0) > events.length) {
    truncated = true;
    limitations.push(`Kubernetes events were limited to ${input.limits.maxEvents}.`);
  }
  if (scope.resourceName && pods.length === 0 && !podsResult.error) {
    limitations.push(
      `No pods matched ${scope.resourceKind ?? "resource"}/${scope.resourceName} in namespace ${scope.namespace}.`,
    );
  }

  const logs = podsResult.error
    ? { excerpts: [], truncated: false, failed: false }
    : await collectLogs(input.reader, scope.namespace, pods, input.limits.maxLogLines, limitations);
  if (logs.failed) partial = true;

  const evidence = prepareEvidence({
    collectedAt: (input.now ?? new Date()).toISOString(),
    ...(input.reader.contextLabel() ? { contextLabel: input.reader.contextLabel() } : {}),
    scope,
    collection: {
      pods,
      services,
      events,
      logs: logs.excerpts,
      limitations,
      truncated: truncated || logs.truncated,
    },
    maxEvidenceChars: input.limits.maxEvidenceChars,
  });

  if (!Value.Check(kubernetesEvidenceSchema, evidence)) {
    throw new Error("Collected evidence did not match the evidence contract.");
  }

  return { evidence, partial };
}

async function collectLogs(
  reader: ClusterReader,
  namespace: string,
  pods: PodSnapshot[],
  maxLogLines: number,
  limitations: string[],
): Promise<{ excerpts: LogExcerpt[]; truncated: boolean; failed: boolean }> {
  const ordered = [...pods].sort((left, right) => Number(left.ready) - Number(right.ready) || left.name.localeCompare(right.name));
  const excerpts: LogExcerpt[] = [];
  let remaining = maxLogLines;
  let truncated = false;
  let failed = false;

  for (const pod of ordered) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const container = logContainer(pod);
    if (!container) continue;
    const tailLines = Math.min(linesPerLog, remaining);
    const text = await readLog(reader, namespace, pod.name, container.name, tailLines, container.previous);
    if (text.error) {
      failed = true;
      limitations.push(`Logs for pod/${pod.name} container ${container.name} were unavailable: ${text.error}`);
      continue;
    }
    const rawLines = text.value
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    if (rawLines.length > tailLines) truncated = true;
    const lines = rawLines.slice(-tailLines).map((line) => line.slice(0, 500));
    if (lines.length === 0) continue;
    excerpts.push({ podName: pod.name, containerName: container.name, lines });
    remaining -= lines.length;
  }

  if (remaining <= 0 && ordered.length > excerpts.length) truncated = true;
  if (truncated) limitations.push(`Log excerpts were limited to ${maxLogLines} lines.`);
  return { excerpts, truncated, failed };
}

function logContainer(pod: PodSnapshot): { name: string; previous: boolean } | undefined {
  const container =
    pod.containers.find((item) => item.waitingReason || item.terminatedReason || item.lastTerminationReason) ??
    pod.containers[0];
  if (!container) return undefined;
  return {
    name: container.name,
    previous: Boolean(container.lastTerminationReason) && !container.ready,
  };
}

async function readLog(
  reader: ClusterReader,
  namespace: string,
  podName: string,
  containerName: string,
  tailLines: number,
  previous: boolean,
): Promise<{ value: string; error?: string }> {
  const attempts = previous ? [true, false] : [false];
  let lastError: string | undefined;
  for (const usePrevious of attempts) {
    try {
      const value = await reader.readPodLog({
        namespace,
        podName,
        containerName,
        tailLines,
        previous: usePrevious,
      });
      if (value.trim()) return { value };
    } catch (error) {
      lastError = safeErrorMessage(error);
    }
  }
  return lastError ? { value: "", error: lastError } : { value: "" };
}

function selectPods(pods: PodSnapshot[], services: ServiceSnapshot[], scope: ResolvedScope): PodSnapshot[] {
  if (!scope.resourceName) return pods;
  const kind = scope.resourceKind?.toLowerCase();
  if (!kind || kind === "pod") return pods.filter((pod) => pod.name === scope.resourceName);
  if (kind === "deployment") {
    return pods.filter(
      (pod) =>
        pod.name === scope.resourceName ||
        pod.name.startsWith(`${scope.resourceName}-`) ||
        pod.labels["app"] === scope.resourceName ||
        pod.labels["app.kubernetes.io/name"] === scope.resourceName,
    );
  }
  if (kind === "service") {
    const service = services.find((item) => item.name === scope.resourceName);
    if (!service || Object.keys(service.selector).length === 0) return [];
    return pods.filter((pod) => matchesSelector(pod.labels, service.selector));
  }
  return pods.filter((pod) => pod.name === scope.resourceName);
}

function selectServices(
  services: ServiceSnapshot[],
  pods: PodSnapshot[],
  scope: ResolvedScope,
): ServiceSnapshot[] {
  const kind = scope.resourceKind?.toLowerCase();
  if (kind === "service" && scope.resourceName) {
    return services.filter((service) => service.name === scope.resourceName);
  }
  if (scope.resourceName && (!kind || kind === "pod")) {
    const pod = pods.find((item) => item.name === scope.resourceName);
    if (!pod) return [];
    return services.filter(
      (service) => Object.keys(service.selector).length > 0 && matchesSelector(pod.labels, service.selector),
    );
  }
  return services;
}

function selectEvents(
  events: EventSnapshot[],
  pods: PodSnapshot[],
  services: ServiceSnapshot[],
  scope: ResolvedScope,
  maxEvents: number,
): EventSnapshot[] {
  const names = new Set<string>([
    ...pods.map((pod) => pod.name),
    ...services.map((service) => service.name),
    ...(scope.resourceName ? [scope.resourceName] : []),
  ]);
  const related = scope.resourceName ? events.filter((event) => event.involvedName && names.has(event.involvedName)) : events;
  return [...related].sort(compareEventTime).slice(0, maxEvents);
}

function compareEventTime(left: EventSnapshot, right: EventSnapshot): number {
  return (right.timestamp ?? "").localeCompare(left.timestamp ?? "");
}

function matchesSelector(labels: Record<string, string>, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

async function readSource<T>(label: string, read: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: `${label} failed: ${safeErrorMessage(error)}` };
  }
}

import type { KubernetesEvidence } from "@kube-lens/contracts";
import type {
  ContainerSnapshot,
  EventSnapshot,
  LogExcerpt,
  PodSnapshot,
  ServiceSnapshot,
} from "../kubernetes/types.ts";
import { sanitizeText } from "./sanitize.ts";
import type { ResolvedScope } from "./scope.ts";

export interface PreparedCollection {
  pods: PodSnapshot[];
  services: ServiceSnapshot[];
  events: EventSnapshot[];
  logs: LogExcerpt[];
  limitations: string[];
  truncated: boolean;
}

export function prepareEvidence(input: {
  collectedAt: string;
  contextLabel?: string;
  scope: ResolvedScope;
  collection: PreparedCollection;
  maxEvidenceChars: number;
}): KubernetesEvidence {
  const observations: KubernetesEvidence["observations"] = [];

  for (const pod of [...input.collection.pods].sort((left, right) => left.name.localeCompare(right.name))) {
    observations.push({
      id: "",
      source: "pod",
      resource: `pod/${pod.name}`,
      severity: podSeverity(pod),
      message: sanitizeText(podMessage(pod)),
    });
  }

  for (const service of [...input.collection.services].sort((left, right) => left.name.localeCompare(right.name))) {
    observations.push({
      id: "",
      source: "service",
      resource: `service/${service.name}`,
      severity: "info",
      message: sanitizeText(serviceMessage(service)),
    });
  }

  const events = [...input.collection.events].sort(compareEvents);
  for (const event of events) {
    const observation: KubernetesEvidence["observations"][number] = {
      id: "",
      source: "event",
      severity: eventSeverity(event.type),
      message: sanitizeText(eventMessage(event)),
    };
    if (event.involvedName) {
      observation.resource = `${(event.involvedKind ?? "object").toLowerCase()}/${event.involvedName}`;
    }
    if (event.timestamp) observation.timestamp = event.timestamp;
    observations.push(observation);
  }

  for (const log of input.collection.logs) {
    const message = sanitizeText(log.lines.join("\n")).trim();
    if (!message) continue;
    observations.push({
      id: "",
      source: "log",
      resource: `pod/${log.podName}`,
      severity: "info",
      message,
    });
  }

  for (const [index, observation] of observations.entries()) {
    observation.id = `E${index + 1}`;
    if (!observation.message.trim()) observation.message = "[redacted]";
  }

  const notReady = input.collection.pods.filter((pod) => !pod.ready).length;
  const logLines = input.collection.logs.reduce((total, log) => total + log.lines.length, 0);
  const evidence: KubernetesEvidence = {
    collectedAt: input.collectedAt,
    scope: {
      namespace: input.scope.namespace,
      ...(input.scope.resourceKind ? { resourceKind: input.scope.resourceKind } : {}),
      ...(input.scope.resourceName ? { resourceName: input.scope.resourceName } : {}),
    },
    observations,
    summary: summary({
      namespace: input.scope.namespace,
      pods: input.collection.pods.length,
      services: input.collection.services.length,
      events: input.collection.events.length,
      logLines,
      notReady,
    }),
    collectionStats: {
      pods: input.collection.pods.length,
      services: input.collection.services.length,
      events: input.collection.events.length,
      logLines,
    },
    truncated: input.collection.truncated,
    limitations: [...input.collection.limitations],
  };
  if (input.contextLabel) evidence.clusterContextLabel = input.contextLabel.slice(0, 200);

  if (fitCharBudget(evidence, input.maxEvidenceChars)) {
    evidence.truncated = true;
    evidence.limitations.push("Evidence was truncated to the configured size limit.");
    const includedPods = evidence.observations.filter((observation) => observation.source === "pod");
    evidence.collectionStats = {
      pods: includedPods.length,
      services: evidence.observations.filter((observation) => observation.source === "service").length,
      events: evidence.observations.filter((observation) => observation.source === "event").length,
      logLines: evidence.observations
        .filter((observation) => observation.source === "log")
        .reduce((total, observation) => total + observation.message.split("\n").length, 0),
    };
    const includedPodNames = new Set(includedPods.map((observation) => observation.resource));
    const notReady = input.collection.pods.filter(
      (pod) => !pod.ready && includedPodNames.has(`pod/${pod.name}`),
    ).length;
    evidence.summary = summary({
      namespace: input.scope.namespace,
      pods: evidence.collectionStats.pods,
      services: evidence.collectionStats.services,
      events: evidence.collectionStats.events,
      logLines: evidence.collectionStats.logLines,
      notReady,
    });
  }

  return evidence;
}

function podMessage(pod: PodSnapshot): string {
  const containers = pod.containers.map(containerMessage).join(" ");
  return `Pod ${pod.name} is ${pod.phase}${pod.ready ? " and ready" : ""}. ${containers}`.trim();
}

function containerMessage(container: ContainerSnapshot): string {
  let state = "is not ready";
  if (container.waitingReason) state = `is waiting (${container.waitingReason})`;
  else if (container.terminatedReason) state = `terminated (${container.terminatedReason})`;
  else if (container.ready) state = "is ready";
  const last = container.lastTerminationReason ? `, last termination ${container.lastTerminationReason}` : "";
  return `Container ${container.name} image ${container.image} ${state}${last}, restarts ${container.restartCount}.`;
}

function serviceMessage(service: ServiceSnapshot): string {
  const selector = Object.entries(service.selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const parts = [
    `Service ${service.name} type ${service.type}`,
    service.clusterIP ? `clusterIP ${service.clusterIP}` : "",
    service.ports.length > 0 ? `ports ${service.ports.join(", ")}` : "no ports",
    selector ? `selector ${selector}` : "no selector",
  ];
  return parts.filter(Boolean).join(", ") + ".";
}

function eventMessage(event: EventSnapshot): string {
  const involved = event.involvedName
    ? `${event.involvedKind ?? "Object"}/${event.involvedName}`
    : "an object";
  const count = event.count > 1 ? ` x${event.count}` : "";
  return `${event.type} ${event.reason}${count} for ${involved}: ${event.message}`.trim();
}

function podSeverity(pod: PodSnapshot): "info" | "warning" | "error" {
  const reasons = pod.containers.flatMap((container) =>
    [container.waitingReason, container.terminatedReason, container.lastTerminationReason].filter(
      (reason): reason is string => Boolean(reason),
    ),
  );
  if (reasons.some((reason) => /OOMKilled|ImagePull|ErrImagePull|CrashLoop|Error|BackOff/i.test(reason))) {
    return "error";
  }
  if (!pod.ready) return "warning";
  return "info";
}

function eventSeverity(type: string): "info" | "warning" | "unknown" {
  if (type === "Warning") return "warning";
  if (type === "Normal") return "info";
  return "unknown";
}

function compareEvents(left: EventSnapshot, right: EventSnapshot): number {
  const leftTime = left.timestamp ?? "";
  const rightTime = right.timestamp ?? "";
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
  return `${left.involvedName ?? ""}`.localeCompare(`${right.involvedName ?? ""}`);
}

function summary(input: {
  namespace: string;
  pods: number;
  services: number;
  events: number;
  logLines: number;
  notReady: number;
}): string {
  const readyNote = input.notReady > 0 ? ` ${input.notReady} pod${input.notReady === 1 ? " is" : "s are"} not ready.` : "";
  return `Collected ${input.pods} pods, ${input.services} services, ${input.events} events, and ${input.logLines} log lines from namespace ${input.namespace}.${readyNote}`;
}

function fitCharBudget(evidence: KubernetesEvidence, maxChars: number): boolean {
  const fits = () => JSON.stringify(evidence).length <= maxChars;
  if (fits()) return false;
  let truncated = false;
  while (evidence.observations.length > 1 && !fits()) {
    evidence.observations.pop();
    truncated = true;
  }
  const last = evidence.observations[0];
  if (last && !fits()) {
    const overhead = JSON.stringify({ ...evidence, observations: [{ ...last, message: "" }] }).length;
    last.message = last.message.slice(0, Math.max(1, maxChars - overhead));
    truncated = true;
  }
  return truncated;
}

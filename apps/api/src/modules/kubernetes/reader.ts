import {
  CoreV1Api,
  KubeConfig,
  type CoreV1Event,
  type V1ContainerStatus,
  type V1Pod,
  type V1Service,
} from "@kubernetes/client-node";
import type {
  ClusterReader,
  ContainerSnapshot,
  EventSnapshot,
  PodSnapshot,
  ServiceSnapshot,
} from "./types.ts";

const listLimit = 100;

interface CoreReader {
  listNamespacedPod(param: { namespace: string; limit?: number }): Promise<{ items?: V1Pod[] }>;
  listNamespacedService(param: { namespace: string; limit?: number }): Promise<{ items?: V1Service[] }>;
  listNamespacedEvent(param: { namespace: string; limit?: number }): Promise<{ items?: CoreV1Event[] }>;
  readNamespacedPodLog(param: {
    name: string;
    namespace: string;
    container?: string;
    tailLines?: number;
    previous?: boolean;
    timestamps?: boolean;
  }): Promise<string>;
}

export function createKubeconfigReader(contextName?: string): ClusterReader {
  const config = loadKubeConfig(contextName);
  const context = config.getCurrentContext();
  return createClusterReader(config.makeApiClient(CoreV1Api), context || undefined);
}

export function loadKubeConfig(contextName?: string): KubeConfig {
  const config = new KubeConfig();
  config.loadFromDefault();
  if (contextName) config.setCurrentContext(contextName);
  return config;
}

export function createClusterReader(core: CoreReader, contextLabel?: string): ClusterReader {
  return {
    contextLabel: () => contextLabel,
    async listPods(namespace) {
      const list = await core.listNamespacedPod({ namespace, limit: listLimit });
      return (list.items ?? []).map(toPodSnapshot);
    },
    async listServices(namespace) {
      const list = await core.listNamespacedService({ namespace, limit: listLimit });
      return (list.items ?? []).map(toServiceSnapshot);
    },
    async listEvents(namespace) {
      const list = await core.listNamespacedEvent({ namespace, limit: listLimit });
      return (list.items ?? []).map(toEventSnapshot);
    },
    async readPodLog(input) {
      return core.readNamespacedPodLog({
        name: input.podName,
        namespace: input.namespace,
        container: input.containerName,
        tailLines: input.tailLines,
        previous: input.previous,
        timestamps: true,
      });
    },
  };
}

export function toPodSnapshot(pod: V1Pod): PodSnapshot {
  const statuses = pod.status?.containerStatuses ?? [];
  const specContainers = pod.spec?.containers ?? [];
  const names = new Set<string>([
    ...specContainers.map((container) => container.name),
    ...statuses.map((status) => status.name),
  ]);
  const containers = [...names].map((name) => {
    const spec = specContainers.find((container) => container.name === name);
    const status = statuses.find((item) => item.name === name);
    return toContainerSnapshot(name, spec?.image ?? status?.image ?? "unknown", status);
  });
  const phase = pod.status?.phase ?? "Unknown";
  const ready = phase === "Running" && containers.length > 0 && containers.every((container) => container.ready);

  return {
    name: pod.metadata?.name ?? "unknown",
    namespace: pod.metadata?.namespace ?? "",
    phase,
    ready,
    labels: pod.metadata?.labels ?? {},
    containers,
  };
}

function toContainerSnapshot(
  name: string,
  image: string,
  status: V1ContainerStatus | undefined,
): ContainerSnapshot {
  const snapshot: ContainerSnapshot = {
    name,
    image,
    ready: status?.ready ?? false,
    restartCount: status?.restartCount ?? 0,
  };
  const waitingReason = status?.state?.waiting?.reason;
  const waitingMessage = status?.state?.waiting?.message;
  const terminatedReason = status?.state?.terminated?.reason;
  const lastTerminationReason = status?.lastState?.terminated?.reason;
  if (waitingReason) snapshot.waitingReason = waitingReason;
  if (waitingMessage) snapshot.waitingMessage = waitingMessage;
  if (terminatedReason) snapshot.terminatedReason = terminatedReason;
  if (lastTerminationReason) snapshot.lastTerminationReason = lastTerminationReason;
  return snapshot;
}

export function toServiceSnapshot(service: V1Service): ServiceSnapshot {
  const ports = (service.spec?.ports ?? []).map((port) => {
    const target = port.targetPort === undefined ? "" : `->${String(port.targetPort)}`;
    return `${port.port}/${port.protocol ?? "TCP"}${target}`;
  });
  const snapshot: ServiceSnapshot = {
    name: service.metadata?.name ?? "unknown",
    namespace: service.metadata?.namespace ?? "",
    type: service.spec?.type ?? "ClusterIP",
    ports,
    selector: service.spec?.selector ?? {},
  };
  if (service.spec?.clusterIP && service.spec.clusterIP !== "None") {
    snapshot.clusterIP = service.spec.clusterIP;
  }
  return snapshot;
}

export function toEventSnapshot(event: CoreV1Event): EventSnapshot {
  const timestamp = toIso(event.lastTimestamp) ?? toIso(event.firstTimestamp) ?? toIso(event.metadata?.creationTimestamp);
  const snapshot: EventSnapshot = {
    type: event.type ?? "Unknown",
    reason: event.reason ?? "Unknown",
    message: event.message ?? "",
    count: event.count ?? 1,
  };
  if (event.involvedObject?.kind) snapshot.involvedKind = event.involvedObject.kind;
  if (event.involvedObject?.name) snapshot.involvedName = event.involvedObject.name;
  if (timestamp) snapshot.timestamp = timestamp;
  return snapshot;
}

function toIso(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString();
  return iso.length >= 20 && iso.length <= 40 ? iso : undefined;
}

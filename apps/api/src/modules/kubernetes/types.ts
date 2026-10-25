export interface ContainerSnapshot {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  waitingReason?: string;
  waitingMessage?: string;
  terminatedReason?: string;
  lastTerminationReason?: string;
}

export interface PodSnapshot {
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  labels: Record<string, string>;
  containers: ContainerSnapshot[];
}

export interface ServiceSnapshot {
  name: string;
  namespace: string;
  type: string;
  clusterIP?: string;
  ports: string[];
  selector: Record<string, string>;
}

export interface EventSnapshot {
  type: string;
  reason: string;
  message: string;
  involvedKind?: string;
  involvedName?: string;
  count: number;
  timestamp?: string;
}

export interface LogExcerpt {
  podName: string;
  containerName: string;
  lines: string[];
}

export interface ClusterReader {
  contextLabel(): string | undefined;
  listPods(namespace: string): Promise<PodSnapshot[]>;
  listServices(namespace: string): Promise<ServiceSnapshot[]>;
  listEvents(namespace: string): Promise<EventSnapshot[]>;
  readPodLog(input: {
    namespace: string;
    podName: string;
    containerName: string;
    tailLines: number;
    previous: boolean;
  }): Promise<string>;
}

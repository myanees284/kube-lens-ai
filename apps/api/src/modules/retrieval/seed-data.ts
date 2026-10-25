export interface SeedIncident {
  title: string;
  problemSummary: string;
  errorTokens: string[];
  logPatterns: string[];
  resourceKinds: string[];
  relevantSignals: string[];
  rcaSummary: string;
  evidenceSummary: string;
  action: string;
}

export interface SeedDocument {
  documentId: string;
  title: string;
  sectionPath: string;
  text: string;
  keywords: string[];
  resourceKinds: string[];
}

export const seedIncidents: SeedIncident[] = [
  {
    title: "Image pull failed because the registry host does not exist",
    problemSummary: "A pod stays in ImagePullBackOff because its image registry host cannot be resolved.",
    errorTokens: ["ImagePullBackOff", "ErrImagePull"],
    logPatterns: ["no such host", "failed to pull image"],
    resourceKinds: ["Pod"],
    relevantSignals: ["image pull", "registry host"],
    rcaSummary: "The container image points at a registry host that DNS cannot resolve, so the kubelet never starts the container.",
    evidenceSummary: "Pod status is Pending or ImagePullBackOff and events report ErrImagePull.",
    action: "Correct the image repository host or publish the image to a registry the cluster can reach.",
  },
  {
    title: "Liveness probe path returns 404",
    problemSummary: "A container starts, fails its HTTP liveness probe with status 404, and enters CrashLoopBackOff.",
    errorTokens: ["CrashLoopBackOff", "Unhealthy"],
    logPatterns: ["Liveness probe failed", "statuscode: 404"],
    resourceKinds: ["Pod"],
    relevantSignals: ["liveness probe", "http 404"],
    rcaSummary: "The liveness probe requests a path the process does not serve. Kubernetes kills and restarts the container.",
    evidenceSummary: "Events show Unhealthy and Killing, and the container waits in CrashLoopBackOff.",
    action: "Point the liveness probe at a path that returns success, or add that endpoint to the application.",
  },
  {
    title: "Container exceeded its memory limit",
    problemSummary: "A container is OOMKilled because it allocates more memory than its limit.",
    errorTokens: ["OOMKilled", "CrashLoopBackOff"],
    logPatterns: ["OOMKilled"],
    resourceKinds: ["Pod"],
    relevantSignals: ["memory limit", "oom"],
    rcaSummary: "The container crossed its cgroup memory limit. The runtime terminated it with OOMKilled and Kubernetes restarted it.",
    evidenceSummary: "The container last termination reason is OOMKilled and the pod restarts.",
    action: "Raise the memory limit to the workload's real use or reduce the memory the process allocates.",
  },
];

export const seedDocuments: SeedDocument[] = [
  {
    documentId: "image-pull-backoff",
    title: "ImagePullBackOff",
    sectionPath: "workloads/pods/image-pull",
    text: "ImagePullBackOff means the kubelet is retrying an image pull that already failed. ErrImagePull is the first failure. A missing registry host, a missing tag, or denied registry credentials are common causes. The container does not start, so it has no application logs.",
    keywords: ["ImagePullBackOff", "ErrImagePull", "image"],
    resourceKinds: ["Pod"],
  },
  {
    documentId: "liveness-probe",
    title: "Liveness probe failure",
    sectionPath: "workloads/pods/probes",
    text: "A failing liveness probe tells Kubernetes the container should be restarted. An HTTP probe fails when the status code is not between 200 and 399. Repeated failures show up as Unhealthy events and then CrashLoopBackOff.",
    keywords: ["liveness", "CrashLoopBackOff", "probe"],
    resourceKinds: ["Pod"],
  },
  {
    documentId: "oomkilled",
    title: "OOMKilled",
    sectionPath: "workloads/pods/resources",
    text: "OOMKilled means the container used more memory than its limit and the runtime stopped it. The pod can still show Running while the container waits to restart. Check the memory limit before treating the process as a general crash.",
    keywords: ["OOMKilled", "memory", "limit"],
    resourceKinds: ["Pod"],
  },
];

export function incidentSearchText(incident: SeedIncident): string {
  return [incident.title, incident.problemSummary, incident.errorTokens.join(" "), incident.logPatterns.join(" "), incident.rcaSummary].join("\n");
}

export function documentSearchText(document: SeedDocument): string {
  return [document.title, document.sectionPath, document.keywords.join(" "), document.text].join("\n");
}

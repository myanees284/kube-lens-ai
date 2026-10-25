import { CoreV1Api, VersionApi } from "@kubernetes/client-node";
import { loadKubeConfig } from "./reader.ts";

export interface ClusterSummary {
  name: string;
  cluster: string;
  current: boolean;
  active: boolean;
}

export function describeClusters(
  contexts: Array<{ name: string; cluster?: string }>,
  current: string,
  active: ReadonlySet<string>,
): ClusterSummary[] {
  return contexts.map((context) => ({
    name: context.name,
    cluster: context.cluster || context.name,
    current: context.name === current,
    active: active.has(context.name),
  }));
}

export async function listKubeClusters(): Promise<ClusterSummary[]> {
  let config: ReturnType<typeof loadKubeConfig>;
  try {
    config = loadKubeConfig();
  } catch {
    return [];
  }
  const contexts = config.getContexts();
  const current = config.getCurrentContext();
  const probes = await Promise.all(
    contexts.map(async (context) => {
      const active = await probeContext(context.name);
      return active ? context.name : "";
    }),
  );
  return describeClusters(contexts, current, new Set(probes.filter((name) => name.length > 0)));
}

export async function listClusterNamespaces(context: string): Promise<string[]> {
  const core = coreClient(context);
  const list = await core.listNamespace({ limit: 200 });
  return names(list.items);
}

export async function listClusterResourceNames(context: string, namespace: string, kind: string): Promise<string[]> {
  const core = coreClient(context);
  if (kind === "Service") {
    const list = await core.listNamespacedService({ namespace, limit: 200 });
    return names(list.items);
  }
  const list = await core.listNamespacedPod({ namespace, limit: 200 });
  return names(list.items);
}

export function knownContext(name: string): boolean {
  try {
    return loadKubeConfig().getContexts().some((context) => context.name === name);
  } catch {
    return false;
  }
}

function coreClient(context: string): CoreV1Api {
  return loadKubeConfig(context).makeApiClient(CoreV1Api);
}

function names(items: Array<{ metadata?: { name?: string } }> | undefined): string[] {
  return (items ?? [])
    .map((item) => item.metadata?.name ?? "")
    .filter((name) => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function probeContext(name: string): Promise<boolean> {
  try {
    const config = loadKubeConfig(name);
    const version = config.makeApiClient(VersionApi);
    await withTimeout(version.getCode(), 2_500);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The cluster did not respond.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

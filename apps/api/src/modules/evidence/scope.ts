import type { InvestigationScope } from "@kube-lens/contracts";

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export interface ResolvedScope {
  namespace: string;
  resourceKind?: string;
  resourceName?: string;
}

export function resolveCollectionScope(
  scope: InvestigationScope,
  defaultNamespace: string | null,
): ResolvedScope {
  const namespace = scope.namespace?.trim() || defaultNamespace?.trim() || "";
  if (!namespace) {
    throw new ScopeError(
      "A namespace is required. Pass scope.namespace or set DEFAULT_NAMESPACE. Cluster-wide collection is disabled.",
    );
  }

  const resolved: ResolvedScope = { namespace };
  const resourceKind = scope.resourceKind?.trim();
  const resourceName = scope.resourceName?.trim();
  if (resourceKind) resolved.resourceKind = resourceKind;
  if (resourceName) resolved.resourceName = resourceName;
  return resolved;
}

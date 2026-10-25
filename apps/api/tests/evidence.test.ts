import { describe, expect, it, vi } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { collectEvidence } from "../src/modules/evidence/collect.ts";
import { sanitizeText } from "../src/modules/evidence/sanitize.ts";
import { ScopeError } from "../src/modules/evidence/scope.ts";
import { createClusterReader } from "../src/modules/kubernetes/reader.ts";
import type { ClusterReader, PodSnapshot } from "../src/modules/kubernetes/types.ts";

const limits = { maxLogLines: 10, maxEvents: 5, maxEvidenceChars: 20_000 };

describe("sanitizeText", () => {
  it("redacts credentials and keeps failure reasons", () => {
    const input = [
      "ImagePullBackOff",
      "OOMKilled",
      "Authorization: Bearer super-secret-token",
      "password=hunter2",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join(" ");

    const sanitized = sanitizeText(input);

    expect(sanitized).toContain("ImagePullBackOff");
    expect(sanitized).toContain("OOMKilled");
    expect(sanitized).not.toContain("super-secret-token");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("eyJhbGci");
  });
});

describe("collectEvidence", () => {
  it("requires a namespace and does not read the cluster without one", async () => {
    const reader = fakeReader();
    const listPods = vi.spyOn(reader, "listPods");

    await expect(
      collectEvidence({ reader, scope: {}, defaultNamespace: null, limits }),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(listPods).not.toHaveBeenCalled();
  });

  it("uses the configured default namespace when the request omits one", async () => {
    const reader = fakeReader();

    const result = await collectEvidence({
      reader,
      scope: { resourceName: "book-catalog" },
      defaultNamespace: "book-prod",
      limits,
      now: new Date("2026-10-24T12:00:00.000Z"),
    });

    expect(result.evidence.scope.namespace).toBe("book-prod");
    expect(result.evidence.observations.map((observation) => observation.resource)).toContain("pod/book-catalog");
  });

  it("builds stable evidence for healthy, image, liveness, and memory failures", async () => {
    const reader = fakeReader({
      listPods: async () => [catalogPod(), ordersPod(), paymentsPod(), searchPod()],
      listEvents: async () => [
        {
          type: "Warning",
          reason: "Unhealthy",
          message: "Liveness probe failed: HTTP probe failed with statuscode: 404",
          involvedKind: "Pod",
          involvedName: "book-payments",
          count: 4,
          timestamp: "2026-10-24T12:01:00.000Z",
        },
      ],
      readPodLog: async (input) => {
        if (input.podName === "book-search") return "password=hunter2\nallocation failed";
        if (input.podName === "book-orders") throw new Error("container is waiting");
        return "listening on 80";
      },
    });

    const result = await collectEvidence({
      reader,
      scope: { namespace: "book-prod" },
      defaultNamespace: null,
      limits,
      now: new Date("2026-10-24T12:00:00.000Z"),
    });

    const messages = result.evidence.observations.map((observation) => observation.message).join("\n");
    expect(result.partial).toBe(true);
    expect(result.evidence.clusterContextLabel).toBe("minikube");
    expect(result.evidence.observations.map((observation) => observation.id)).toEqual(
      result.evidence.observations.map((_, index) => `E${index + 1}`),
    );
    expect(messages).toContain("Pod book-catalog is Running and ready");
    expect(messages).toContain("ErrImagePull");
    expect(messages).toContain("Liveness probe failed");
    expect(messages).toContain("OOMKilled");
    expect(messages).not.toContain("hunter2");
    expect(result.evidence.collectionStats.pods).toBe(4);
    expect(result.evidence.limitations.some((item) => item.includes("book-orders"))).toBe(true);
  });

  it("keeps successful observations when one source fails", async () => {
    const reader = fakeReader({
      listEvents: async () => {
        throw new Error("events.k8s.io unavailable token=abc");
      },
    });

    const result = await collectEvidence({
      reader,
      scope: { namespace: "book-prod" },
      defaultNamespace: null,
      limits,
    });

    expect(result.partial).toBe(true);
    expect(result.evidence.observations.some((observation) => observation.source === "pod")).toBe(true);
    expect(result.evidence.limitations.join(" ")).toContain("Event list failed");
    expect(result.evidence.limitations.join(" ")).not.toContain("token=abc");
  });

  it("limits log lines and marks the evidence truncated", async () => {
    const reader = fakeReader({
      readPodLog: async () => Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n"),
    });

    const result = await collectEvidence({
      reader,
      scope: { namespace: "book-prod" },
      defaultNamespace: null,
      limits: { ...limits, maxLogLines: 3 },
    });

    expect(result.evidence.truncated).toBe(true);
    expect(result.evidence.collectionStats.logLines).toBeLessThanOrEqual(3);
    expect(result.evidence.limitations.join(" ")).toContain("limited to 3 lines");
  });
});

describe("kubernetes snapshots", () => {
  it("maps pod status reasons without calling write APIs", async () => {
    const calls: string[] = [];
    const core = {
      async listNamespacedPod() {
        calls.push("listNamespacedPod");
        return { items: [ordersPodObject()] };
      },
      async listNamespacedService() {
        calls.push("listNamespacedService");
        return { items: [] };
      },
      async listNamespacedEvent() {
        calls.push("listNamespacedEvent");
        return {
          items: [
            {
              type: "Warning",
              reason: "Failed",
              message: "Failed to pull image",
              count: 2,
              involvedObject: { kind: "Pod", name: "book-orders" },
              metadata: {},
              lastTimestamp: new Date("2026-10-24T12:00:00.000Z"),
            },
          ],
        };
      },
      async readNamespacedPodLog() {
        calls.push("readNamespacedPodLog");
        return "";
      },
    };

    const reader = createClusterReader(core, "minikube");
    const pods = await reader.listPods("book-prod");
    const events = await reader.listEvents("book-prod");

    expect(calls).toEqual(["listNamespacedPod", "listNamespacedEvent"]);
    expect(pods[0]?.containers[0]?.waitingReason).toBe("ErrImagePull");
    expect(events[0]?.reason).toBe("Failed");
    expect(events[0]?.timestamp).toBe("2026-10-24T12:00:00.000Z");
  });
});

function fakeReader(overrides: Partial<ClusterReader> = {}): ClusterReader {
  const reader: ClusterReader = {
    contextLabel: () => "minikube",
    listPods: async () => [catalogPod()],
    listServices: async () => [],
    listEvents: async () => [],
    readPodLog: async () => "listening on 80",
  };
  return { ...reader, ...overrides };
}

function catalogPod(): PodSnapshot {
  return pod("book-catalog", { ready: true, phase: "Running" });
}

function ordersPod(): PodSnapshot {
  return pod("book-orders", {
    ready: false,
    phase: "Pending",
    waitingReason: "ErrImagePull",
    image: "example.invalid/book-orders:missing",
  });
}

function paymentsPod(): PodSnapshot {
  return pod("book-payments", {
    ready: false,
    phase: "Running",
    waitingReason: "CrashLoopBackOff",
    lastTerminationReason: "Error",
  });
}

function searchPod(): PodSnapshot {
  return pod("book-search", {
    ready: false,
    phase: "Running",
    waitingReason: "CrashLoopBackOff",
    lastTerminationReason: "OOMKilled",
  });
}

function pod(
  name: string,
  input: {
    ready: boolean;
    phase: string;
    waitingReason?: string;
    lastTerminationReason?: string;
    image?: string;
  },
): PodSnapshot {
  return {
    name,
    namespace: "book-prod",
    phase: input.phase,
    ready: input.ready,
    labels: { app: name },
    containers: [
      {
        name,
        image: input.image ?? "nginx:1.27-alpine",
        ready: input.ready,
        restartCount: input.ready ? 0 : 2,
        ...(input.waitingReason ? { waitingReason: input.waitingReason } : {}),
        ...(input.lastTerminationReason ? { lastTerminationReason: input.lastTerminationReason } : {}),
      },
    ],
  };
}

function ordersPodObject(): V1Pod {
  return {
    metadata: { name: "book-orders", namespace: "book-prod" },
    spec: { containers: [{ name: "book-orders", image: "example.invalid/book-orders:missing" }] },
    status: {
      phase: "Pending",
      containerStatuses: [
        {
          name: "book-orders",
          ready: false,
          restartCount: 0,
          image: "example.invalid/book-orders:missing",
          imageID: "",
          containerID: "",
          state: { waiting: { reason: "ErrImagePull", message: "failed to pull" } },
        },
      ],
    },
  } as V1Pod;
}

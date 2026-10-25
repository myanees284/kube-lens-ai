import { describe, expect, it } from "vitest";
import { describeClusters } from "../src/modules/kubernetes/clusters.ts";

describe("describeClusters", () => {
  it("marks the reachable context as active", () => {
    const clusters = describeClusters(
      [
        { name: "minikube", cluster: "minikube" },
        { name: "dev", cluster: "dev-cluster" },
      ],
      "minikube",
      new Set(["minikube"]),
    );

    expect(clusters).toEqual([
      { name: "minikube", cluster: "minikube", current: true, active: true },
      { name: "dev", cluster: "dev-cluster", current: false, active: false },
    ]);
  });
});
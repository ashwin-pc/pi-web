import { describe, expect, it } from "vitest";
import { guidedContainerTarget, verifyGuidedContainerIsolation } from "../server/runtime/networkIsolation.js";

function fakeRun(responses: Record<string, unknown>) {
  return async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (!(key in responses)) throw new Error(`Unexpected command: ${key}`);
    return { stdout: JSON.stringify(responses[key]) };
  };
}

describe("guided container network isolation", () => {
  it("recognizes persisted guided exec commands", () => {
    expect(guidedContainerTarget({ command: "/opt/bin/container", args: ["exec", "-i", "apple-box", "sh"], kind: "container" })).toEqual({ adapter: "apple", target: "apple-box" });
    expect(guidedContainerTarget({ command: "docker", args: ["exec", "--env", "A=B", "docker-box", "sh"], kind: "container" })).toEqual({ adapter: "docker", target: "docker-box" });
    expect(guidedContainerTarget({ command: "ssh", args: ["host"], kind: "ssh" })).toBeUndefined();
  });

  it("accepts an Apple host-only network", async () => {
    const run = fakeRun({
      "container inspect safe": [{ configuration: { dns: null }, status: { networks: [{ network: "pi-web-safe" }] } }],
      "container network inspect pi-web-safe": [{ configuration: { mode: "hostOnly" } }],
    });
    await expect(verifyGuidedContainerIsolation("apple", "safe", run)).resolves.toEqual({ network: "pi-web-safe", networkPolicy: "none" });
  });

  it("rejects Apple's internet-capable default network", async () => {
    const run = fakeRun({
      "container inspect unsafe": [{ configuration: { dns: null }, status: { networks: [{ network: "default" }] } }],
      "container network inspect default": [{ configuration: { mode: "nat" } }],
    });
    await expect(verifyGuidedContainerIsolation("apple", "unsafe", run)).rejects.toThrow(/internet-capable network default/);
  });

  it("requires Apple DNS to be disabled", async () => {
    const run = fakeRun({
      "container inspect dns-enabled": [{ configuration: { dns: { nameservers: [] } }, status: { networks: [{ network: "pi-web-safe" }] } }],
    });
    await expect(verifyGuidedContainerIsolation("apple", "dns-enabled", run)).rejects.toThrow(/--no-dns/);
  });

  it("accepts Docker none but rejects internal and bridge networks", async () => {
    await expect(verifyGuidedContainerIsolation("docker", "none", fakeRun({
      "docker inspect none": [{ HostConfig: { NetworkMode: "none" }, NetworkSettings: { Networks: {} } }],
    }))).resolves.toEqual({ network: "none", networkPolicy: "none" });

    await expect(verifyGuidedContainerIsolation("docker", "internal", fakeRun({
      "docker inspect internal": [{ HostConfig: { NetworkMode: "pi-safe" }, NetworkSettings: { Networks: { "pi-safe": {} } } }],
    }))).rejects.toThrow(/must use --network none/);

    await expect(verifyGuidedContainerIsolation("docker", "bridge", fakeRun({
      "docker inspect bridge": [{ HostConfig: { NetworkMode: "bridge" }, NetworkSettings: { Networks: { bridge: {} } } }],
    }))).rejects.toThrow(/must use --network none/);
  });
});

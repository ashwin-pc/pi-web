import { readFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem, type, uptime } from "node:os";
import { join } from "node:path";
import type { SystemInfoSnapshot } from "../src/systemInfo/types.js";

function packageVersion(packageFile: string): string {
  try {
    const value = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown };
    return typeof value.version === "string" && value.version.trim() ? value.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

export function createSystemInfoProvider(options: {
  appDir: string;
  agentDir: string;
  environment: SystemInfoSnapshot["piWeb"]["environment"];
  host: string;
  port: number;
}) {
  const piWebVersion = packageVersion(join(options.appDir, "package.json"));
  const piVersion = packageVersion(join(options.appDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));

  return function systemInfoSnapshot(): SystemInfoSnapshot {
    if (options.environment === "mock") {
      return {
        capturedAt: "2026-01-15T12:00:00.000Z",
        piWeb: {
          version: "0.5.0",
          environment: "mock",
          nodeVersion: "v22.0.0",
          processId: 4242,
          processUptimeSeconds: 754,
          installDirectory: "/opt/pi-web",
          listenAddress: "127.0.0.1:9876",
        },
        pi: {
          version: "0.82.0",
          agentDirectory: "/home/pi/.pi/agent",
        },
        host: {
          hostname: "pi-web-host",
          operatingSystem: "Linux",
          platform: "linux",
          release: "6.8.0",
          architecture: "arm64",
          cpuModel: "Mock 8-Core Processor",
          logicalCpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeMemoryBytes: 6 * 1024 ** 3,
          uptimeSeconds: 4 * 86400 + 3 * 3600 + 22 * 60,
        },
      };
    }

    const processors = cpus();
    return {
      capturedAt: new Date().toISOString(),
      piWeb: {
        version: piWebVersion,
        environment: options.environment,
        nodeVersion: process.version,
        processId: process.pid,
        processUptimeSeconds: process.uptime(),
        installDirectory: options.appDir,
        listenAddress: `${options.host}:${options.port}`,
      },
      pi: {
        version: piVersion,
        agentDirectory: options.agentDir,
      },
      host: {
        hostname: hostname(),
        operatingSystem: type(),
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpuModel: processors[0]?.model?.trim() || "Unknown processor",
        logicalCpuCount: processors.length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
        uptimeSeconds: uptime(),
      },
    };
  };
}

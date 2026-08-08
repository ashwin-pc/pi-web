export type SystemInfoSnapshot = {
  capturedAt: string;
  piWeb: {
    version: string;
    environment: "development" | "production" | "mock";
    nodeVersion: string;
    processId: number;
    processUptimeSeconds: number;
    installDirectory: string;
    listenAddress: string;
  };
  pi: {
    version: string;
    agentDirectory: string;
  };
  host: {
    hostname: string;
    operatingSystem: string;
    platform: string;
    release: string;
    architecture: string;
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    uptimeSeconds: number;
  };
};

import { PiWebConnector } from "./connectors/pi-web-connector.ts";

const fixtureCwd = "/local/home/ashwinpc/oss/pi-web/benchmarks/agent-health/fixtures/smoke-workspace";

export default {
  // Only our agents — hide agent-health's built-in demo/sample agents
  // (demo, observio, claude-code, strands, pi, langgraph-rest) from run dialogs.
  extends: false,
  server: {
    port: 4001,
    reuseExistingServer: true,
  },
  connectors: [new PiWebConnector() as any],
  agents: [
    {
      key: "pi-web-baseline",
      name: "pi-web (baseline)",
      endpoint: "http://127.0.0.1:8787",
      connectorType: "pi-web" as any,
      useTraces: false,
      connectorConfig: {
        cwd: fixtureCwd,
      },
    },
  ],
  // The pi-web session model remains agent-owned. Runs are judged only by
  // the restricted evidence agent, so the run dialog has no irrelevant
  // demo, pi, or Bedrock-catalog choices.
  models: [
    {
      key: "agent-evidence-judge",
      model_id: "agent-evidence-judge",
      display_name: "Agent evidence judge (restricted bash)",
      provider: "agent",
      context_window: 200_000,
      max_output_tokens: 16_384,
    },
  ],
  judge: {
    provider: "agent",
    model: "agent-evidence-judge",
  },
};

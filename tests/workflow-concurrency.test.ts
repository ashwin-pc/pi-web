import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = (name: string) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
const concurrency = (name: string) => workflow(name).match(/^concurrency:\n((?:[ \t].*\n)+)/m)?.[1];

describe("workflow cancellation policy", () => {
  it("supersedes revisions only within the same PR and workflow", () => {
    expect(concurrency("pr")).toBe(
      "  group: ${{ github.workflow }}-pr-${{ github.event.pull_request.number }}\n"
      + "  cancel-in-progress: true\n",
    );
  });

  it("isolates Wavy PRs while leaving each main push independent", () => {
    expect(concurrency("wavy")).toBe(
      "  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}\n"
      + "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    );
  });

  it("does not enable cancellation for deployments or releases", () => {
    expect(concurrency("pages")).toBe("  group: pages\n  cancel-in-progress: false\n");
    expect(concurrency("release")).toBeUndefined();
  });
});

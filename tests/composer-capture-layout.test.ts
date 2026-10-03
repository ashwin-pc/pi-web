import { describe, expect, it } from "vitest";
import { captureChromeMetrics, captureChromeTargets } from "../src/composer/composerCaptureLayout.js";

const style = (values: Record<string, string>) => ({
  getPropertyValue: (name: string) => values[name] ?? "",
});

describe("composer capture chrome layout contract", () => {
  it("uses canonical CSS geometry rather than the currently compact footer measurement", () => {
    const metrics = captureChromeMetrics(style({
      "--composer-footer-height": "44px",
      "--composer-action-size": "44px",
    }), 38);

    expect(captureChromeTargets(metrics, 1)).toEqual({
      footerHeight: 44,
      actionSize: 44,
      actionWidthStart: 0,
      actionWidthEnd: 44,
      settlingInputWidth: 88,
      idleInputWidth: 44,
    });
  });

  it("falls back to measured layout when a host does not expose tokens", () => {
    const metrics = captureChromeMetrics(style({}), 52);
    expect(captureChromeTargets(metrics, 2)).toMatchObject({
      footerHeight: 52,
      actionSize: 52,
      settlingInputWidth: 156,
    });
  });
});

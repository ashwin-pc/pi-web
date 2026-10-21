import { describe, expect, it, vi } from "vitest";
import { OperationFences } from "../../server/session/operationFences.js";
const fences = () => new OperationFences((message, status, recoveryRequired) => Object.assign(new Error(message), { status, recoveryRequired }));

describe("operation safety policy", () => {
  it("does not cancel or wait for lifetime dialogs/capture on Stop", async () => {
    const f = fences(); const dialog = f.begin("lifetime"); f.stop();
    expect(dialog.canceled).toBe(false); expect(f.requiresRecovery({})).toBe(false);
    expect(f.hasTranscriptWork).toBe(false); await f.settleTranscript(); dialog.finish();
  });
  it("keeps shell settlement ownership without canceling or fencing the next prompt", async () => {
    const f = fences(); const shell = f.begin("shell"); f.stop();
    expect(shell.canceled).toBe(false);
    expect(f.requiresRecovery({})).toBe(false);
    expect(() => f.assertTranscript({})).not.toThrow();
    expect(f.hasTranscriptWork).toBe(true);
    let settled = false;
    const wait = f.settleTranscript().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    shell.finish(); await wait; expect(settled).toBe(true);
  });
  it("distinguishes admitted prompts from canceled preflight and cannot resurrect old epochs", () => {
    const f = fences(); const admitted = f.begin("prompt"); f.admitted(admitted, f.epoch, false); f.stop();
    expect(f.requiresRecovery({})).toBe(false);
    const preflight = f.begin("prompt"); const epoch = f.epoch; f.stop();
    expect(f.requiresRecovery({ isIdle: true, pendingMessageCount: 0 })).toBe(true);
    expect(() => f.admitted(preflight, epoch, false)).toThrow("canceled");
    f.assertOpen(); expect(() => f.assertTranscript({})).toThrow("settling");
    preflight.finish(); admitted.finish(); expect(f.requiresRecovery({})).toBe(false);
  });
  it("reconciles USER ambiguity only after canceled preflight settles AND known idle/zero", () => {
    const f = fences(); const token = f.begin("prompt"); const epoch = f.epoch; f.stop();
    expect(() => f.admitted(token, epoch, true)).toThrow();
    expect(f.requiresRecovery({ isIdle: true, pendingMessageCount: 0 })).toBe(true);
    token.finish(); expect(f.requiresRecovery({ isIdle: true })).toBe(true);
    expect(f.requiresRecovery({ pendingMessageCount: 0 })).toBe(true);
    expect(f.requiresRecovery({ isIdle: true, pendingMessageCount: 0 })).toBe(false);
  });
  it("retains one closing/retirement owner after timeout and settles rejected operations", async () => {
    const f = fences(); const token = f.begin("transcript"); let finish!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const retirement = f.retire(async () => { await f.settleTranscript(); await cleanup(); });
    await expect(f.wait(retirement, "Disposal", 5)).rejects.toMatchObject({ status: 503, recoveryRequired: true });
    expect(() => f.begin("lifetime")).toThrow("closing");
    expect(f.retire(cleanup)).toBe(retirement); expect(cleanup).not.toHaveBeenCalled();
    token.finish(); await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce()); finish(); await retirement;
  });
});

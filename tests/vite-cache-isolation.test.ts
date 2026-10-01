import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viteCacheDir } from "../vite.config.js";

describe("Vite optimizer cache isolation", () => {
  it("keeps worktrees separate even when they share symlinked node_modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-vite-cache-"));
    try {
      const first = join(dir, "first");
      const second = join(dir, "second");
      await mkdir(first);
      await mkdir(second);
      await mkdir(join(dir, "shared-node-modules"));
      await symlink(join(dir, "shared-node-modules"), join(first, "node_modules"));
      await symlink(join(dir, "shared-node-modules"), join(second, "node_modules"));
      const env = { command: "serve" as const, mode: "development" };
      expect(viteCacheDir(env, "8788", first)).not.toBe(viteCacheDir(env, "8788", second));
      expect(viteCacheDir(env, "8788", first).startsWith(join(first, ".vite-cache") + "/")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("partitions build, development and concurrent server ports deterministically", () => {
    const root = "/example/worktree";
    const dev = { command: "serve" as const, mode: "development" };
    const cache = viteCacheDir(dev, "8788", root);
    expect(viteCacheDir(dev, "8788", root)).toBe(cache);
    expect(viteCacheDir(dev, "9876", root)).not.toBe(cache);
    expect(viteCacheDir({ command: "serve", mode: "test" }, "8788", root)).not.toBe(cache);
    expect(viteCacheDir({ command: "build", mode: "production" }, "8788", root)).not.toBe(cache);
  });
});

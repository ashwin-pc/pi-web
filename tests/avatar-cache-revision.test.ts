import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { avatarAssetRevision } from "../vite.config.js";

describe("avatar cache revision", () => {
  it("is stable for unchanged artwork and changes for bytes or paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-avatar-cache-"));
    try {
      await mkdir(join(dir, "fox"));
      const asset = join(dir, "fox", "new-session.apng");
      await writeFile(asset, "first animation");
      const original = avatarAssetRevision(dir);
      expect(avatarAssetRevision(dir)).toBe(original);
      await writeFile(asset, "changed animation");
      expect(avatarAssetRevision(dir)).not.toBe(original);
      const changed = avatarAssetRevision(dir);
      await mkdir(join(dir, "cat"));
      await writeFile(join(dir, "cat", "still.png"), "a still");
      expect(avatarAssetRevision(dir)).not.toBe(changed);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

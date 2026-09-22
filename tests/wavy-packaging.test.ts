import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWavyPreviewAssets, renderWavyView } from "../examples/pi-web-extensions/wavy/preview.js";
import type { LoadedProject } from "../examples/pi-web-extensions/wavy/types.js";
import { verifyWavyPackage } from "../scripts/verify-wavy-package.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const wavyRoot = join(root, "examples/pi-web-extensions/wavy");

async function packageFixture(change?: (wavy: string) => Promise<void>) {
  const fixture = await mkdtemp(join(tmpdir(), "wavy-package-fixture-"));
  const wavy = join(fixture, "package/examples/pi-web-extensions/wavy");
  await mkdir(wavy, { recursive: true });
  for (const path of ["README.md", "browser.js", "index.ts", "player.ts", "player-model.ts", "preview.ts", "styles.css", "store.ts", "types.ts", "settings.ts", "engines.ts", "engine/README.md", "engine/sheetsage.py", "engine/yue.py", "skill/SKILL.md"]) {
    await mkdir(dirname(join(wavy, path)), { recursive: true });
    await cp(join(wavyRoot, path), join(wavy, path));
  }
  await cp(join(wavyRoot, "vendor"), join(wavy, "vendor"), { recursive: true });
  await change?.(wavy);
  const archive = join(fixture, "fixture.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "package"], { cwd: fixture, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr);
  return { fixture, archive };
}

describe("Wavy build and package contract", () => {
  it("reports an actionable error when the generated browser bundle is absent", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "wavy-missing-browser-"));
    try {
      await writeFile(join(fixture, "styles.css"), "body{}");
      await expect(readWavyPreviewAssets(fixture)).rejects.toThrow(/npm run build:wavy-browser/);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("does not read ABCjs or stage piano samples for a project without a saved score", async () => {
    const assetFixture = await mkdtemp(join(tmpdir(), "wavy-no-notation-assets-"));
    await writeFile(join(assetFixture, "styles.css"), "body{}");
    await writeFile(join(assetFixture, "browser.js"), '"use strict";');
    await expect(readWavyPreviewAssets(assetFixture, false)).resolves.toEqual(["body{}", '"use strict";', ""]);
    await rm(assetFixture, { recursive: true, force: true });

    const cwd = await mkdtemp(join(tmpdir(), "wavy-no-score-"));
    const project: LoadedProject = {
      absolutePath: join(cwd, "draft.wavy"), artifactPath: "/api/artifacts/draft.wavy", warnings: [],
      head: { lyrics: "Draft", style: "", settings: { precision: "bf16", planning: "off", maxSemanticTokens: 9000 } },
      index: { format: "wavy", version: 1, title: "Draft", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z", revision: 0, revisions: [], sources: [], takes: [] },
    };
    try {
      const view = await renderWavyView(project);
      expect(view).not.toContain("abcjs_basic v6.4.4");
      await expect(access(join(cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("includes ABCjs for a renderable in-memory score without requiring revision file metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wavy-unpersisted-score-"));
    const project: LoadedProject = {
      absolutePath: join(cwd, "draft.wavy"), artifactPath: "/api/artifacts/draft.wavy", warnings: [],
      head: { lyrics: "Draft", style: "", score: "X:1\nK:C\nC4|", settings: { precision: "bf16", planning: "off", maxSemanticTokens: 9000 } },
      index: { format: "wavy", version: 1, title: "Draft", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z", revision: 0, revisions: [], sources: [], takes: [] },
    };
    try {
      const view = await renderWavyView(project);
      expect(view).toContain("abcjs_basic v6.4.4");
      await expect(access(join(cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("matches every vendored byte length and hash in the shipped-subset manifest", async () => {
    const vendor = join(root, "examples/pi-web-extensions/wavy/vendor");
    const manifest = JSON.parse(await readFile(join(vendor, "manifest.json"), "utf8")) as {
      schemaVersion: number;
      upstreams: Array<{ notice: string; shippedFiles: Array<{ path: string; bytes: number; sha256: string }> }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.upstreams.flatMap(item => item.shippedFiles)).toHaveLength(1);
    for (const upstream of manifest.upstreams) {
      await expect(access(join(vendor, upstream.notice))).resolves.toBeUndefined();
      for (const file of upstream.shippedFiles) {
        const data = await readFile(join(vendor, file.path));
        expect(data.byteLength, file.path).toBe(file.bytes);
        expect(createHash("sha256").update(data).digest("hex"), file.path).toBe(file.sha256);
      }
    }
  });

  it("rejects missing or tampered bundles, undeclared vendor files, and caches", async () => {
    const cases: Array<[(wavy: string) => Promise<void>, RegExp]> = [
      [async wavy => rm(join(wavy, "browser.js")), /missing browser\.js/],
      [async wavy => writeFile(join(wavy, "browser.js"), '"use strict"; tampered'), /differs from the canonical/],
      [async wavy => writeFile(join(wavy, "vendor/unexpected.bin"), "extra"), /Undeclared vendored files/],
      [async wavy => { await mkdir(join(wavy, "nested/__pycache__"), { recursive: true }); await writeFile(join(wavy, "nested/__pycache__/x.pyc"), "cache"); }, /cache\/test artifacts/],
    ];
    for (const [change, message] of cases) {
      const { fixture, archive } = await packageFixture(change);
      try { await expect(verifyWavyPackage(archive)).rejects.toThrow(message); }
      finally { await rm(fixture, { recursive: true, force: true }); }
    }
  });

  it("keeps Wavy generation opt-in for development and mandatory for builds", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.dev).not.toMatch(/wavy/i);
    expect(pkg.scripts["watch:wavy-browser"]).toContain("--watch");
    expect(pkg.scripts.build).toMatch(/^npm run build:wavy-browser/);
    expect(pkg.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toContain("examples/pi-web-extensions/wavy/browser.js");
  });
});

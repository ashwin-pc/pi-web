import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDirectory, readWorkspaceFile, readWorkspaceImage, WorkspaceFileError, writeWorkspaceFile } from "../server/shared/workspaceFiles.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-files-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(join(root, "README.md"), "# Workspace\n");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "hidden.js"), "hidden");
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("workspace files", () => {
  it("lists directories lazily, sorts folders first, and hides noisy directories", async () => {
    const root = await workspace();
    const listing = await listWorkspaceDirectory(root, "", false);
    expect(listing.entries.map(({ name, kind }) => [name, kind])).toEqual([
      ["src", "directory"],
      ["README.md", "file"],
    ]);
    const hidden = await listWorkspaceDirectory(root, "", true);
    expect(hidden.entries.map((entry) => entry.name)).toContain("node_modules");
    expect((await listWorkspaceDirectory(root, "src", false)).entries[0]?.path).toBe("src/app.ts");
  });

  it("reads language metadata and writes atomically with revision conflict protection", async () => {
    const root = await workspace();
    const initial = await readWorkspaceFile(root, "src/app.ts");
    expect(initial.language).toBe("typescript");
    expect(initial.content).toContain("value = 1");
    const saved = await writeWorkspaceFile(root, "src/app.ts", "export const value = 2;\n", initial.revision);
    expect(saved.revision).not.toBe(initial.revision);
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toContain("value = 2");
    await expect(writeWorkspaceFile(root, "src/app.ts", "stale", initial.revision)).rejects.toMatchObject({ status: 409 });
  });

  it("serves supported workspace images for preview", async () => {
    const root = await workspace();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIApA2nWQAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(root, "preview.png"), png);
    const image = await readWorkspaceImage(root, "preview.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toEqual(png);
    await writeFile(join(root, "fake.png"), "not really an image");
    await expect(readWorkspaceImage(root, "fake.png")).rejects.toMatchObject({ status: 415 });
    await expect(readWorkspaceImage(root, "README.md")).rejects.toMatchObject({ status: 415 });
  });

  it("rejects traversal, binary files, oversized files, and escaping symlinks", async () => {
    const root = await workspace();
    await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await writeFile(join(root, "large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    const outside = await mkdtemp(join(tmpdir(), "pi-web-files-outside-")); roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(readWorkspaceFile(root, "../secret.txt")).rejects.toBeInstanceOf(WorkspaceFileError);
    await expect(readWorkspaceFile(root, "binary.dat")).rejects.toMatchObject({ status: 415 });
    await expect(readWorkspaceFile(root, "large.txt")).rejects.toMatchObject({ status: 413 });
    await expect(readWorkspaceFile(root, "escape.txt")).rejects.toMatchObject({ status: 403 });
  });
});

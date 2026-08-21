import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShallowLister, type ShallowListMetrics } from "../server/session/shallowList.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("shallow session listing", () => {
  it("projects bounded metadata without depending on transcript body size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-shallow-"));
    roots.push(cwd);
    const directory = join(cwd, "sessions");
    await mkdir(directory);
    const id = "019f328a-bc2c-772b-a095-81b1ad27d054";
    const path = join(directory, `2026-07-05T13-49-40-780Z_${id}.jsonl`);
    const lines = [
      { type: "session", id, timestamp: "2026-07-05T13:49:40.780Z", cwd },
      { type: "message", message: { role: "user", content: [{ type: "text", text: " First   prompt " }] } },
      { type: "session_info", name: "Initial" },
    ].map(JSON.stringify);
    const inflatedBody = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(1024) } })}\n`.repeat(100);
    await writeFile(path, `${lines.join("\n")}\n${inflatedBody}${JSON.stringify({ type: "session_info", name: "Late rename" })}\n`);

    const baseline: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const [info] = await createShallowLister().list(cwd, directory, baseline);
    expect(info).toMatchObject({ id, cwd, name: "Late rename", firstMessage: "First prompt", created: "2026-07-05T13:49:40.780Z" });
    expect(info.messageCount).toBeUndefined();

    await writeFile(path, `${lines.join("\n")}\n${inflatedBody.repeat(10)}${JSON.stringify({ type: "session_info", name: "Late rename" })}\n`);
    const inflated: ShallowListMetrics = { files: 0, bytesRead: 0 };
    await createShallowLister().list(cwd, directory, inflated);
    expect(inflated).toEqual(baseline);
    expect(inflated.bytesRead).toBeLessThanOrEqual(40 * 1024);
  });

  it("keeps bounded per-session work as visited cwd and corpus size grow", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-soak-"));
    roots.push(root);
    const metrics: ShallowListMetrics = { files: 0, bytesRead: 0 };
    let listed = 0;
    for (let cwdIndex = 0; cwdIndex < 20; cwdIndex += 1) {
      const cwd = join(root, `cwd-${cwdIndex}`);
      const directory = join(cwd, "sessions");
      await mkdir(directory, { recursive: true });
      for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
        const id = `${cwdIndex}-${sessionIndex}`;
        const path = join(directory, `2026-07-05T13-49-40-780Z_${id}.jsonl`);
        const header = JSON.stringify({ type: "session", id, timestamp: "2026-07-05T13:49:40.780Z", cwd });
        await writeFile(path, `${header}\n${"x".repeat(96 * 1024)}\n`);
      }
      listed += (await createShallowLister().list(cwd, directory, metrics)).length;
    }
    expect(listed).toBe(200);
    expect(metrics.files).toBe(200);
    expect(metrics.bytesRead).toBeLessThanOrEqual(metrics.files * 40 * 1024);
  });

  it("stat-gated cache makes a repeated scan read zero bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-web-cache-"));
    roots.push(cwd);
    const directory = join(cwd, "sessions");
    await mkdir(directory);
    const lister = createShallowLister();
    const mkSession = async (name: string, id: string) => {
      const path = join(directory, `2026-07-05T13-49-40-780Z_${id}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: "session", id, timestamp: "2026-07-05T13:49:40.780Z", cwd })}\n${JSON.stringify({ type: "session_info", name })}\n`);
      return path;
    };
    await mkSession("Alpha", "a");
    await mkSession("Beta", "b");

    const first: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const firstList = await lister.list(cwd, directory, first);
    expect(first.files).toBe(2);
    expect(first.bytesRead).toBeGreaterThan(0);

    // The same directory, unchanged, must be served entirely from the stat-gated
    // cache: stat the 2 files, read 0 bytes (#112 regression guard).
    const second: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const secondList = await lister.list(cwd, directory, second);
    expect(second.files).toBe(2);
    expect(second.bytesRead).toBe(0);
    expect(secondList).toEqual(firstList);

    // Appending to one file invalidates only that entry (size changed); the other
    // stays cached. The rebuilt DTO must reflect the new tail bytes.
    const betaPath = join(directory, `2026-07-05T13-49-40-780Z_b.jsonl`);
    await writeFile(betaPath, `${JSON.stringify({ type: "session_info", name: "Beta renamed" })}\n`, { flag: "a" });
    const third: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const thirdList = await lister.list(cwd, directory, third);
    expect(third.files).toBe(2);
    expect(third.bytesRead).toBeGreaterThan(0);
    expect(third.bytesRead).toBeLessThan(second.bytesRead + 40 * 1024);
    expect(thirdList.find((s) => s.id === "b")?.name).toBe("Beta renamed");
    expect(thirdList.find((s) => s.id === "a")?.name).toBe("Alpha");
  });

  it("keeps the cache warm across directories (multi-cwd list)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-multicwd-"));
    roots.push(root);
    const mkSession = async (directory: string, name: string, id: string) => {
      await writeFile(join(directory, `2026-07-05T13-49-40-780Z_${id}.jsonl`),
        `${JSON.stringify({ type: "session", id, timestamp: "2026-07-05T13:49:40.780Z", cwd: directory })}\n${JSON.stringify({ type: "session_info", name })}\n`);
    };
    const dirA = join(root, "a", "sessions");
    const dirB = join(root, "b", "sessions");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await mkSession(dirA, "Alpha", "a");
    await mkSession(dirB, "Beta", "b");

    // Model the multi-cwd pathology (service.list() scans one directory per known
    // cwd via Promise.all): a second directory's scan must NOT evict the first's
    // entries. Each dir owns its own inner map. Concurrent like production; we
    // assert BOTH stay warm — on a flattened single shared map only one survives
    // a concurrent pair, so at least one of these re-reads (deterministic FAIL).
    const lister = createShallowLister();
    await Promise.all([lister.list(dirA, dirA), lister.list(dirB, dirB)]);
    const againA: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const againB: ShallowListMetrics = { files: 0, bytesRead: 0 };
    const [listA, listB] = await Promise.all([
      lister.list(dirA, dirA, againA),
      lister.list(dirB, dirB, againB),
    ]);
    expect(againA.bytesRead).toBe(0); // FAILS with a single shared map
    expect(againB.bytesRead).toBe(0); // FAILS with a single shared map
    expect(listA[0]?.name).toBe("Alpha");
    expect(listB[0]?.name).toBe("Beta");
  });
});

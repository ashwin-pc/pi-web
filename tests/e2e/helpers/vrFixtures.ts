import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { seedSessionUiState } from "./sessionUiState.js";

/** A small RGB PNG, drawn by a per-pixel function: enough for a real image artifact without binary fixtures. */
export function pngOf(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** An ASCII STL of a stepped, notched dial (real geometry for the pedestal). */
export function dialStl(segments = 48) {
  const rings: Array<[number, number]> = [[0, 0], [10, 0], [10, 5], [7, 6], [6, 8], [3, 8], [3, 0.01]];
  const point = (r: number, z: number, a: number) => [r * Math.cos(a), r * Math.sin(a), z];
  const facets: string[] = [];
  const tri = (a: number[], b: number[], c: number[]) => facets.push(`facet normal 0 0 0\n outer loop\n  vertex ${a.join(" ")}\n  vertex ${b.join(" ")}\n  vertex ${c.join(" ")}\n endloop\nendfacet`);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2, notch = i === 0 ? 0.6 : 0;
    for (let k = 0; k < rings.length - 1; k++) {
      const [r0, z0] = rings[k], [r1, z1] = rings[k + 1];
      const p00 = point(r0, z0, a0), p01 = point(r0, z0, a1), p10 = point(r1, z1 - (k === 3 ? notch : 0), a0), p11 = point(r1, z1, a1);
      tri(p00, p01, p11); tri(p00, p11, p10);
    }
  }
  return `solid dial\n${facets.join("\n")}\nendsolid dial\n`;
}

export const VR_ARTIFACT_DIR = "vr-e2e";

/** Real artifact files of every drawable kind under <cwd>/.pi/web/artifacts/vr-e2e/. Returns their markdown links. */
export async function writeVrArtifacts(cwd = process.cwd()) {
  const dir = join(cwd, ".pi", "web", "artifacts", VR_ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  const files: Record<string, string | Buffer> = {
    "screen-before.png": pngOf(320, 200, (x, y) => (x < 70 ? [24, 24, 24] : y < 24 ? [13, 13, 13] : [(x * 3) % 60, 20, 30])),
    "screen-after.png": pngOf(320, 200, (x, y) => (x < 24 ? [226, 177, 95] : y < 24 ? [13, 13, 13] : [20, (y * 2) % 80, 40])),
    "report.md": "# Rail review\n\nThe rail replaces the tab strip and the drawer list.\n\n## Decisions\n\n- Dots never move.\n- Touch expands on the first tap.\n\n## Next\n\n- Ship behind a flag.\n",
    "fix.diff": "diff --git a/src/money.ts b/src/money.ts\n--- a/src/money.ts\n+++ b/src/money.ts\n@@ -1,3 +1,4 @@\n export function roundCents(amount: number) {\n-  return Math.round(amount * 100) / 100;\n+  const cents = amount * 100;\n+  return Math.round(cents) / 100;\n }\n",
    "flow.mmd": "flowchart TD\n  A[Realtime socket] --> B[Client layer]\n  B --> C[Root view slot]\n  C --> D[City]\n  C --> E[2D app]\n",
    "dial.stl": dialStl(),
    "playground.html": "<!doctype html><title>Playground</title><h1>Playground</h1>",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  const link = (label: string, name: string) => `[${label}](/api/artifacts/${VR_ARTIFACT_DIR}/${name})`;
  return [
    link("Screen before", "screen-before.png"), link("Screen after", "screen-after.png"), link("Rail review", "report.md"),
    link("Rounding fix", "fix.diff"), link("Data flow", "flow.mmd"), link("Dial part", "dial.stl"), link("Playground", "playground.html"),
  ];
}

/** Create mock sessions with short transcripts (each prompt gets a mock reply), and pin them in order. */
export async function seedVrSessions(page: Page, options: { extra?: number; worker?: boolean; artifacts?: string[] } = {}) {
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data });
    if (!response.ok()) throw new Error(`${url} ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const ids = ["mock-current", "mock-older"];
  const names = ["Bar layout", "Ledger migration", "Docs pass", "Flaky e2e", "Search index"];
  for (let i = 0; i < (options.extra || 0); i++) {
    const created = await post("/api/sessions/new", i === 0 && options.worker ? { origin: { sessionId: "mock-older", kind: "spawn" } } : {});
    ids.push(created.sessionId);
    await post("/api/session/name", { sessionId: created.sessionId, name: names[i % names.length] });
    await post("/api/prompt", { sessionId: created.sessionId, message: `Summarise the ${names[i % names.length].toLowerCase()} in markdown` });
  }
  if (options.artifacts?.length) await post("/api/prompt", { sessionId: "mock-older", message: `Outputs for review: ${options.artifacts.join(" ")}` });
  const since = new Date().toISOString();
  await seedSessionUiState(page, { lanes: ids.map((sessionId) => ({ sessionId, lane: "pinned", since })) });
  return ids;
}

import { stlEnvironment, stlFloorFactor, stlViewingBounds, stlViewingRotation } from "./stl-environment.js";
import { readFileSync } from "node:fs";
import { artifactFile, esc, errorView } from "./shared.js";
import { deriveStlEdges } from "./stl-edges.js";
const runtime = readFileSync(new URL("./stl-runtime.js", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./stl.css", import.meta.url), "utf8");
const icon = (paths: string) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// No mesh read or GPU work occurs until the host supplies the consented stream.
export function stlContribution(getCwd: () => string) {
  return {
    slot: "artifact-preview", kind: "rendered", title: "STL viewer", label: "Full-detail 3D mesh",
    match: { extensions: [".stl"] },
    async derive(artifact: { path: string }, options: { signal: AbortSignal; destination: string }) {
      const source = await artifactFile(getCwd(), artifact.path, 2 * 1024 ** 3, "STL", 2048);
      await deriveStlEdges(source, options.destination, options.signal);
    },
    async render(event: any) {
      if (typeof event?.context?.path !== "string") return errorView("Cannot open STL", "The artifact context is missing.");
      const name = typeof event.context.name === "string" ? event.context.name : "STL model";
      return { artifactBytes: true as const, artifactDerived: true as const, html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><style>${stylesheet}</style></head><body><main class="stage">
<canvas tabindex="0" aria-label="Interactive exact STL mesh. Arrow keys orbit, shift arrows pan, plus and minus zoom, F fits the model." aria-describedby="navigation"></canvas>
<div class="title"><strong title="${esc(name)}">${esc(name)}</strong><p id="status" role="status">Receiving model…</p></div>
<details class="info info-menu"><summary aria-label="Model information" title="Model information">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>')}<span>Info</span></summary><div class="popover information"><div class="eyebrow">SOURCE GEOMETRY</div><strong id="info-count">Decoding…</strong><p id="dimensions"></p><p id="source-size"></p><hr><p>STL has no encoded units. Dimensions are in model units.</p><p>Face normals preserve every triangle. Optional feature edges use source-face angles greater than 35°, plus boundary and nonmanifold edges. Smooth normals and transparency are not computed.</p><hr><label class="check">Up axis <select id="up-axis" aria-label="Model up axis"><option value="z">Z-up (fabrication default)</option><option value="y">Y-up (original viewer)</option></select></label><p>STL has no up-axis metadata. Z-up is the default fabrication convention, not inferred from this file. Changing it rotates the viewing basis only; source geometry is unchanged.</p><label class="check"><input id="ground" type="checkbox" checked> Ground plane</label><label class="check"><input id="grid" type="checkbox" checked> Grid</label><label class="check"><input id="bounds" type="checkbox" checked> Bounding box</label><p id="navigation">Drag to orbit · shift/right-drag to pan · scroll to zoom. Touch: one finger orbits, two fingers pan and pinch. Keyboard: arrows orbit, shift arrows pan, +/− zoom, F fits.</p><p>Unload releases the model and GPU memory. Reopen to load again.</p><hr><p id="edge-status" role="status">Outlines are off. Enable to generate crease and boundary edges.</p><p>Outlines use source-face creases above 35°, not a silhouette. Generation can use up to 1.5 GiB temporary disk; uncheck to cancel.</p></div></details>
<div id="waiting" class="waiting"><span class="loader" aria-hidden="true"></span><strong>Building the exact mesh</strong><p>Every source triangle is retained.</p></div>
<div class="gesture-hint"><span class="touch-hint">Drag to orbit · pinch to zoom</span><span class="mouse-hint">Drag to orbit · scroll to zoom</span></div>
<div class="controls" role="group" aria-label="Model display and navigation">
<button id="reset" class="icon-button" title="Reset orbit, pan and zoom (F)" aria-label="Fit model">${icon('<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>')}<span>Fit</span></button>
<details id="view-menu"><summary class="view-button" aria-label="Camera views" title="Camera views">View <span aria-hidden="true">⌄</span></summary><div class="popover views" role="group" aria-label="Camera views"><button data-view="iso">Isometric</button><button data-view="front">Front</button><button data-view="back">Back</button><button data-view="left">Left</button><button data-view="right">Right</button><button data-view="top">Top</button><button data-view="bottom">Bottom</button><p>Views follow the selected up axis.</p></div></details>
<label class="outline-control" title="Generate crease and boundary outlines; may take time and temporary disk. Uncheck to cancel. Details in Model information."><input id="outlines" type="checkbox" aria-label="Feature outlines" aria-describedby="edge-status"><span><span class="feature-prefix">Feature </span>outlines</span><span id="edge-progress" aria-hidden="true" hidden>…</span></label>

</div></main><script>${runtime.replace("__ENVIRONMENT__", stlEnvironment.toString()).replace("__FLOOR_FACTOR__", stlFloorFactor.toString()).replace("__VIEWING_BOUNDS__", stlViewingBounds.toString()).replace("__VIEWING_ROTATION__", stlViewingRotation.toString())}</script></body></html>` };
    },
  };
}

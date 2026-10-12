# City scene: porting notes

These modules are the vr-city WebXR mock's `src/` (round 3, as of 2026-10-12 03:48; each round is merged three-way onto the port), ported into pi-web with as few
edits as possible, file for file, so later rounds of the mock can be re-applied by diff. They stay plain JavaScript
behind a typed boundary (`main.d.ts`, `client.d.ts`, `host.d.ts`); converting them to TypeScript is a follow-up.

## What replaced the mock's data

- `client.js` is no longer the mock backend. It is a live binding that `../vrApp.ts` fills with the adapter in
  `../cityClient.ts`, which maps pi-web's client state layer (`src/client/`) onto the mock's client interface.
- `src/mock/` (fixtures, synthetic trees, the scripted simulation) is not ported.
- `host.js` (new) tells the scene where to mount and how to leave the view.

## Local edits, by file

| File | Edit |
|---|---|
| `core.js` | The canvas mounts in the root-view element (`host.el`), not `document.body` |
| `avatars.js` | Avatars load from `/avatars/<id>/icon.png` instead of being inlined at build time |
| `state.js` | Starts on the 2D app's session (`client.initialSessionId`); parked and bookmarks lists removed |
| `app.js` | Big-workspace toggle removed; real dictation (Web Speech API) instead of scripted phrases; More gets "Back to chat" |
| `bar.js`, `bar-pops.js` | Parked, bookmarks and big-workspace entries removed from the More chip and menu |
| `desktop.js` | `G` (big workspace) removed |
| `city.js` | `setBig` removed |
| `views.js` | Header shows "Current session" when the model is unknown; composer says when dictation is unavailable |
| `xr.js` | Secure-context and no-WebXR messages for pi-web (no artifact-iframe URL); Enter VR explains why it is disabled |
| `main.js` | No simulation; `disposeCity()` stops the loop and frees GPU resources |
| `hooks.js`, `city-hooks.js`, `r3-hooks.js` | The hook is `window.__vrCity`; mock test drivers replaced by `messages()`, `cityFiles()`, `artifactState()`, `pedestalStatus()` and `threadOverPanels()` |

### Round 3 (use the space)

`focus.js`, `layouts.js`, `tiles.js`, `r3.js` and `r3-hooks.js` are ported unchanged apart from the hook name and the
live-load probe. The artifact modules read real files:

| File | Edit |
|---|---|
| `artifact-draw.js` | Same kinds, styles and exports, but the content is the real file: images, reports (markdown), diffs, Mermaid flowcharts (parsed from `.mmd`), video frames. It is loaded through the client (`host.loadArtifact`), cached, and re-rastered when it arrives. HTML, audio and other files are a card with "Open in 2D" |
| `artifacts.js` | An "Open 2D" header button for HTML, audio and other files (`host.openIn2D`, which opens the 2D artifact viewer); the rail and a pulled-out panel re-raster (and resize to the real aspect) when content arrives |
| `pedestal.js` | The model is the real STL, glTF/GLB, OBJ or PLY file (`model-load.js`, new, three's loaders imported on demand), with a wireframe stand-in while it loads |
| `tiles.js`, `artifact-markers.js` | A pinned artifact re-rasters when its content arrives; markers re-sync when a session's artifacts change |
| `city.js`, `follow.js` | **Fix:** the hover thread (avatar to beam) and the file thread (cockpit to building) are left out wherever a panel covers them, so they never cross a panel's text |
| `reader.js` | A turn that is still streaming is built without mipmaps (rebuilt on every update; the tiles do the same) |
| `xr.js` | The "no headset" note hides after 8 s (Enter VR's tooltip keeps the reason) |

Not ported: `record.mjs` (recording), `build.mjs` (pi-web's Vite build bundles three.js as a lazy chunk), the mock's
test harnesses (pi-web's Playwright specs `tests/e2e/vr-view.spec.ts` and `vr-xr.spec.ts` cover the live view).

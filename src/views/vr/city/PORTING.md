# City scene: porting notes

These modules are the vr-city WebXR mock's `src/` (round 1, as of 2026-10-11 21:36), ported into pi-web with as few
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
| `hooks.js`, `city-hooks.js` | The hook is `window.__vrCity`; mock test drivers replaced by `messages()` and `cityFiles()` |

Not ported: `record.mjs` (recording), `build.mjs` (pi-web's Vite build bundles three.js as a lazy chunk), the mock's
test harnesses (pi-web's Playwright specs `tests/e2e/vr-view.spec.ts` and `vr-xr.spec.ts` cover the live view).

# Wavy sandbox media and asset-bridge validation

Validated 2026-09-19 without changing core authentication or sandbox policy.

## Current generic bridge

| Browser / auth mode | Path exercised | Result |
|---|---|---|
| Chromium / isolated real pi-web / legacy bearer `Authorization` | Real Wavy extension render → server asset normalization → host `mountArtifactPreview` → opaque `sandbox="allow-scripts"` iframe | Passed |
| Chromium / isolated real pi-web / anonymous HTTP | `/api/artifacts/...` and `/api/session-artifacts/...` | Rejected by authentication as expected |
| Chromium / real `pi_web_session` cookie | `tests/e2e/token.spec.ts` — `artifact media bridge` on isolated auth port 19485 | Passed: audio GET used only the cookie, with no `Authorization`; anonymous request returned 401; after logout a fresh `loadAsset` returned 401 |
| Password login ceremony | Not provisioned in this run | **Unverified** |
| Passkey login ceremony | Not provisioned in this run | **Unverified** |
| WebKit / Safari | Not run | **Unverified** |

The isolated server ran on `127.0.0.1:19484` with temporary auth, settings, session, and HOME directories. The only discovered browser contribution was `wavy.preview`; no public server was restarted. A real SDK session was created without an LLM prompt or model load.

The source artifact was `.pi/web/artifacts/wavy-halfway/halfway.wavy` and its retained 89.9-second model WAV. The server returned 16 normalized assets: one WAV and 15 local piano samples. The test loaded the WAV through the authenticated host fetch, received it as a Blob in the opaque iframe, and confirmed:

- the media source was an iframe-owned `blob:null/...` URL, never an authenticated URL;
- playback advanced from 0 to approximately 1.16 seconds;
- seeking reached approximately 12.75 seconds;
- score audition loaded real `wavy-preview-cache/*.mp3` assets over the bridge and showed no oscillator-fallback warning;
- the parsed events exposed canonical ABCJS MIDI pitches and durations;
- live accent changes propagated (`#d946ef` → `#22c55e`) without interrupting playback;
- live font changes propagated (`Courier New` → `Georgia`);
- iframe body margin, main padding, and main border were all `0px`;
- the iframe retained exactly `sandbox="allow-scripts"`.

The original files were unchanged. Recorded SHA-256 values after QA:

- `halfway.wavy`: `cab78c15e0d88daa8333af28752c4c04576f8bc1b131dca046c77ca6872e859c`
- retained `audio.wav`: `02c753a6ba7f9e1657b29d9593be10d045a20753f5242431b373c5e4d9bf376d` (matches the Wavy reference and normalized asset receipt)

Real final-build UI screenshots are retained as [`wavy-preview-in-chat.png`](/api/artifacts/wavy-preview-in-chat.png) and [`wavy-preview-expanded.png`](/api/artifacts/wavy-preview-expanded.png). They were created through a temporary `/wavy-preview-check` extension command that emitted a real chat message, so the native chat artifact card, interaction shield, host mount, Artifacts panel, theme, and typography all participated. The temporary extension and isolated server were removed afterward.

## Legacy direct-media behavior

Direct native media URLs in opaque srcdoc frames remain intentionally unsupported. Persistent coverage in `tests/e2e/wavy.spec.ts` confirms that the sandbox is not weakened and anonymous artifact requests return 401. The new bridge supersedes direct iframe media loading without exposing bearer credentials.

Focused persistent checks:

```sh
PLAYWRIGHT_PORT=19482 npx playwright test tests/e2e/wavy.spec.ts --project=desktop
PI_WEB_E2E_AUTH=1 PLAYWRIGHT_PORT=19485 npx playwright test tests/e2e/wavy.spec.ts --project=desktop --grep 'authenticated core'
```

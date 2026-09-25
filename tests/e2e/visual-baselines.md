# Platform-specific visual baselines

The root `*.spec.ts-snapshots/*.png` files are canonical **macOS** references.
README and website asset consumers also use those paths, so retain their names,
locations, and bytes when recording another platform. `playwright.config.ts`
keeps macOS at the legacy root and places every other platform below
`*.spec.ts-snapshots/{platform}/`; there is no cross-platform fallback.

Recordings are reviewable test data, not proof of correctness. Use
`--update-snapshots=missing` only to acquire missing references, inspect them,
then run the unchanged assertions without any snapshot-update flag. Never
replace a different platform's expectations or raise thresholds to obtain a
passing run. The suite-wide `maxDiffPixelRatio: 0.025` and model-picker `0.001`
remain unchanged.

## Initial Linux recording provenance

Recorded 2026-09-14 from `db5cd6e3e82e3f995e5839e54c667ea453fb4b3a`:
frozen baseline `f7967b87403c31c8f60e845ef7f1e799ada7fa2f` plus the separately
reviewed FAB computed-font fix, with only this snapshot-path policy applied.
No native-harness implementation was present in the recording source.

| Input | Recorded value |
| --- | --- |
| Host | Linux ARM64, Amazon Linux 2 |
| Kernel | Linux 5.10 (ARM64) |
| Node | `v24.15.0` |
| Playwright | `1.59.1` |
| Browser | Default headless Chromium, cache revision `1217` |
| Observed browser version | **`147.0.7727.0`**; package manifest advertises `147.0.7727.15` |
| Browser executable | `chromium_headless_shell-1217/chrome-linux/headless_shell`, ARM aarch64 ELF |
| Executable SHA-256 | `cb6d33decb7807399fdcb9ba249b92db0e9bfeade9bbe50986e75875f89fe65c` |
| Fontconfig | `2.13.0` |
| Lockfile SHA-256 | `73f2edec6a373f7dd3bd0300ad77ffa00b0e9890916ad3ac443a61a0d0c11e47` |

Visible model/version/host labels come from the unchanged mock fixtures; the
table above records the actual capture environment.

The recording used the unchanged mobile (Pixel 5), tablet, and desktop projects;
individual tests retain their existing viewport/scale overrides. Commands ran
with `env -i`, disposable HOME/PI/settings/session/notepad/delegation/cache/tmp
paths, no inherited credentials, and loopback port `49692`. Comparison used a
separate disposable HOME and the identical production build. Dependency files
and the existing browser cache were read-only inputs; no packages were installed
or removed.

### Font inventory

Fontconfig reported 90 distinct font files, grouped below. This distinguishes
host font availability from actual browser selection: CDP probes selected
`DejaVuSans-Bold` for the UI's 650-weight stack, `DejaVuSans` for an Arial probe,
and `DejaVuSansMono` for monospace. Host `fc-match Arial` instead reported
Nimbus Sans; do not substitute that result for the observed browser font.

| Fontconfig family group | Files |
| --- | ---: |
| C059 | 8 |
| D050000L | 2 |
| DejaVu Sans | 4 |
| DejaVu Sans / Condensed | 4 |
| DejaVu Sans / Light | 1 |
| DejaVu Sans Mono | 4 |
| DejaVu Serif | 4 |
| DejaVu Serif / Condensed | 4 |
| Nimbus Mono PS | 8 |
| Nimbus Roman | 8 |
| Nimbus Sans | 8 |
| Nimbus Sans Narrow | 8 |
| P052 | 8 |
| Standard Symbols PS | 1 |
| URW Bookman | 8 |
| URW Gothic | 8 |
| Z003 | 2 |

The full path/family/style/version inventory has SHA-256
`540423eb4c658c287401a3af013c40a6cfe19e051e0cbbe36eba70da391db83d`;
the sorted font-file SHA-256 manifest has SHA-256
`dc8ca3dc2b8ec804cd3079dd534373bd3f4b386276bbe9217c7661b7e65a4975`.

### Acquisition and comparison

These are the exact Playwright arguments, executed inside the isolated
environment described above (JSON report destinations were supplied separately):

```bash
# Data acquisition only; missing references are written, not validated.
node node_modules/@playwright/test/cli.js test \
  tests/e2e/visual.spec.ts tests/e2e/minimal-visual.spec.ts \
  --project=mobile --project=tablet --project=desktop \
  --workers=1 --retries=0 --update-snapshots=missing --reporter=line,json

# Separate ordinary comparison; no snapshot-update flag.
node node_modules/@playwright/test/cli.js test \
  tests/e2e/visual.spec.ts tests/e2e/minimal-visual.spec.ts \
  --project=mobile --project=tablet --project=desktop \
  --workers=1 --retries=0 --reporter=line,json
```

The current assertions require **78 Linux references**: 12 Minimal and 66 visual.
All 80 legacy Mac PNGs remain unchanged. The two additional Mac files,
`sessions-drawer-desktop.png` and `sessions-drawer-mobile.png`, have no current
assertion; no Linux equivalents were invented or copied for them.
The sorted legacy Mac SHA-256 manifest remains
`619f8b4f0dedc022038476f909573ef80e142252d3a5a73f7c9fcbc0047c19c7`.

Acquisition wrote 78 missing references (exit 1: 63 cases reporting only missing
snapshot writes, 27 existing tablet skips, no other errors). Every new reference
was checked byte-for-byte against its retained Playwright `*-actual.png`.
Separate ordinary comparison: **63 passed, 27 existing tablet skips, zero
retries or failures**. Neither platform's references changed during comparison.
The initial Linux SHA-256 manifest remains
`17573f6bf1e67716f0bde2735a51a67cdca4734e8f79f80cad43d24aa670b47b`.

macOS revalidation: **NOT RUN**. Full-suite and independent visual acceptance
remain separate follow-up gates.


## Upstream rebuild recording — 2026-09-25

The Linux additions were reacquired on upstream `55e02e1` with the rebuilt
multi-harness source at `f2849bbbc38e057982207a37c7d60116f43ca3b9`. The original recording predates upstream
session citation controls, populated-draft layout, and the current notepad
example. It is historical provenance, not the expectation for those changes.

Only this branch's 78 Linux additions were reacquired with the documented
`--update-snapshots=missing` procedure, using disposable HOME/state, the same
Chromium cache, and an owned loopback test port. 66 PNGs changed from
the earlier recording. All 80 macOS references are byte-identical to upstream;
no comparison thresholds or test assertions were relaxed. Every acquired PNG
matches its retained browser `actual` image byte-for-byte.

Acquisition reported only missing-reference writes (63 cases and 27 existing
skips); it is not a passing comparison. Ordinary full-suite comparison is a
separate gate reported in the PR.

Current Linux manifest SHA-256: `8a955f0375aec44568026317453efa26a3720412de5bb48ed9847039550a0603`.
Current macOS manifest SHA-256: `bc5187c2a3fbca455a335bc194480ab18e6371e9f01d0ed97d99b8665663eed8`.

Manifest input is sorted `sha256  repository-relative-path` lines with a final
newline. These current manifests supersede the historical recording manifests
above; they do not claim macOS execution.

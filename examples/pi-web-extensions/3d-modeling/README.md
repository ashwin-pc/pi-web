# 3D modeling extension

A shared modeling CLI with **one optional agent tool**, interactive `.stl` and `.gcode` previews, and a **Slice** browser action. The CLI and tool share one dispatcher and backend adapters; neither duplicates execution logic. Discovery is always available, even when a backend is unconfigured.

## Design

The portable `3d-modeling` skill carries modeling reasoning and verification principles; host configuration supplies machine-specific facts; adapters own backend execution; task-specific scripts compose operations without adding agent tools. The host owns authentication, workspace trust, artifact serving and previews. Discovery reports configured or observed evidence—not inferred dependency readiness, reserved resources or a sandbox guarantee. Source migration and session activation are separate: updating files does not reload running sessions.

## CLI and tool

From this repository (Node >=24 and installed dependencies):

```sh
node examples/pi-web-extensions/3d-modeling/cad.mjs help
node examples/pi-web-extensions/3d-modeling/cad.mjs discover
node examples/pi-web-extensions/3d-modeling/cad.mjs fusion capabilities
node examples/pi-web-extensions/3d-modeling/cad.mjs fusion docs --json '{"searchPattern":"LoftSections.add","apiCategory":"member"}'
node examples/pi-web-extensions/3d-modeling/cad.mjs fusion read --json '{"queryType":"activeCommand"}'
```

For another working directory, use `node /absolute/path/to/3d-modeling/cad.mjs help`. The launcher resolves its own installed `tsx` dependency; no caller-side `--import` flags are required. The current directory determines the artifact root. No global command installation or PATH changes are required. The TypeScript entry point also supports `node --import tsx .../cad/cli.ts` from this repository.

The extension registers only `modeling`, taking `{ "args": ["help"] }` or any identical CLI argument vector. `help [command]` is the complete current command and parameter reference. Successful standalone commands emit JSON to stdout; failed commands emit JSON to stderr and exit nonzero. Exit codes: 1 backend/configuration failure, 2 invalid arguments, 124 timeout, 130 cancellation. `--timeout-ms` bounds an invocation: the default is 30 minutes, or 65 minutes for Hunyuan generation to cover its native 3-minute startup, one-hour generation and cleanup budget. Explicit limits are honored. The CLI never asks for interactive input.

Core commands:

- `discover`: offline configuration/filesystem evidence, not a claim of dependency readiness or an idle device.
- `fusion capabilities`: live MCP tool schemas; follow an explicit returned cursor if paginated. The CLI does not expose unrestricted mutating RPC passthrough.
- `fusion read --json OBJECT` and `fusion docs --json OBJECT`: generic reads and runtime API documentation queries, including document/command inspection. An upstream success-only acknowledgement is not documentation: inspect the returned payload. The installed bridge may advertise documentation lookup but return no member/class content.
- `fusion resources [--cursor STRING]`, `fusion resource --json '{"uri":"resource://..."}'`, and `fusion electronics --json OBJECT`: read-only resource and electronics access with runtime schemas from capability discovery. Marketing/purchase/media-generation services are deliberately not exposed as unrestricted executable RPC.
- `fusion screenshot --json '{"output":"view.png","direction":"current"}'`: artifact PNG, preserving the current view when requested.
- `fusion exec --script inspect.py --read-only`: requests upstream design-read-only inspection, failing closed if the installed MCP does not advertise the boolean flag. The bridge is responsible for enforcement; schema presence is not an independent enforcement test and Python is not a filesystem sandbox.
- `fusion exec --script change.py --allow-mutation`: unsandboxed Fusion Python.
- `fusion undo --allow-mutation` / `fusion redo --allow-mutation`: explicit edits; a script is not necessarily one undo transaction.
- `slice --json '{"input":"part.stl","output":"part.gcode"}'`: named-profile PrusaSlicer, no arbitrary slicer arguments.
- `hunyuan generate --json '{"image":"object.png"}'`: existing owned inference adapter; see requirements below.
- `runtime discover` / `runtime exec --json '{"runtime":"blender","script":"model.py"}' --allow-mutation`: configured local script runtimes, without adding agent tools.

Paths are relative to `<cwd>/.pi/web/artifacts` (supported artifact URLs are accepted by adapters). Writes are confined by path checks, but executed Python is **not sandboxed**. A Fusion transport timeout/cancellation does not establish that a remote mutation stopped: inspect state before retrying. Never auto-retry an uncertain mutation.

### Fusion script entry point

Every submitted script must define a **fresh callable `run(context)` accepting one argument**. The MCP executes the source and invokes that callback. Do not put modeling operations at top level, reuse stale callbacks, or assign `run` to a number/path. The CLI forwards scripts unchanged rather than guessing how to wrap them.

```python
def run(context):
    import adsk.core, adsk.fusion
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    print({"document": app.activeDocument.name, "components": design.allComponents.count})
```

Use short inspect → change → verify steps. Errors must propagate; do not suppress exceptions and claim success because an export exists. Entity admissibility, successful feature construction and measured continuity are distinct checks. See the companion skill for modeling principles.

### Configured local runtimes

Configured runtimes are an intentional part of the modeling workflow, not a replacement for bash. They give the portable skill a discoverable contract for installed applications such as Blender and give the tool and CLI the same script snapshot/hash, bounded redacted logs, result artifact and owned cancellation behavior. Backend-specific setup stays on the host rather than in prompts. Adapters provide those modeling-specific contracts around one shared local process manager; Hunyuan retains its specialized owned-ComfyUI lifecycle, and Fusion retains its remote-document semantics.

`PI_MODELING_CONFIG` selects a trusted JSON file, otherwise `~/.pi/modeling.json` is used. Paths are host configuration, not skill instructions. Example:

```json
{
  "version": 1,
  "runtimes": [{
    "id": "blender",
    "description": "Explicit locally installed Blender",
    "executable": "/absolute/path/to/blender",
    "args": ["--background", "--python-exit-code", "1", "--python", "{script}", "--", "{run}"],
    "scriptExtension": ".py",
    "requiredPaths": [],
    "timeoutMs": 120000
  }]
}
```

Placeholders replace whole arguments; `{artifacts}` is also supported. Configure the application's script-failure exit behavior: Blender needs `--python-exit-code 1` to make uncaught script exceptions produce a nonzero exit. A process exit code alone is not an output-validation contract; check expected artifacts and inspect the actual result. Runtime execution snapshots the source and records its SHA-256, runtime descriptor, redacted logs and result under a unique `modeling-runs/` artifact directory. It owns a POSIX process group and terminates group members on cancellation, timeout and leader exit. Windows execution fails closed. Deliberately detached descendants and persistent-service scripts are unsupported. Generic runtimes do not replace the owned-ComfyUI lifecycle or Fusion's document semantics.

### Legacy migration

The narrow `fusion_status`, `fusion_screenshot`, `fusion_execute_script`, `slice_stl`, and optional `comfy_image_to_3d` registrations are removed. Use the corresponding CLI commands above through `modeling.args` or standalone execution. Existing Fusion transport, Hunyuan lifecycle, profile-based slicing, viewers and browser Slice action remain canonical. Old saved transcripts are unchanged; newly invoked legacy tool calls must migrate. No host configuration or running sessions are automatically reloaded by this source change.

## Local image → 3D (Hunyuan3D 2.1)

`hunyuan generate --json OBJECT` accepts `image` (artifact-relative PNG/JPEG/WebP or artifact URL), optional `seed`, `steps` (1–50, default 30), and `resolution` (128 or 256, default 256). It writes a unique `image-to-3d/<run>/` artifact directory containing copied input, API workflow, logs, metadata, and downloadable **untextured GLB geometry**. This is the installed native Hunyuan3D blueprint with LoadImage and SaveGLB endpoints, not texture synthesis. Hidden surfaces are inferred; physical scale, watertightness and printability are not guaranteed. No Blender or downloads are involved. GLB is downloadable; this extension's interactive viewer currently supports STL, not GLB.

The backend reuses the owned-ComfyUI lifecycle and process-identification helpers from the sibling `../image/runner.py` example (no image models/runtime required). Install from this repository using the directory symlink below, or preserve that sibling file when copying examples; do not copy the 3D directory alone.

Generation is disabled by default: set `PI_HUNYUAN_COMFY_ROOT` to the absolute path of your existing ComfyUI checkout to enable the adapter. The CLI and `modeling` tool remain discoverable without this setting. There is no default checkout and registration starts no processes. Requires macOS, Pillow, native 3D nodes and `models/checkpoints/hunyuan_3d_v2.1.safetensors`. The checkout's `.venv/bin/python` launches both the runner and ComfyUI; `PI_HUNYUAN_PYTHON` overrides both with an absolute interpreter path containing those dependencies. Setting only the interpreter does not opt in. Uses macOS `memory_pressure` (at least 25% free) and refuses detected active ComfyUI processes. There is no global inference broker/lock; preflight can race unrelated image/video calls, so run these workloads sequentially. A per-runtime busy guard prevents overlapping calls in the same process. Separate standalone CLI invocations are not a cross-process resource lock.

Only the newly spawned loopback process group is stopped/reaped (SIGTERM followed by SIGKILL escalation), including workflow failure, timeout and cancellation. Existing services are never interrupted. Startup is bounded to three minutes, generation to one hour; input is limited to 25 MB/16 megapixels and output to 250 MB. Inputs and output real paths must stay inside the artifact tree. No process starts during registration. Standalone CLI calls use their invocation environment. For extension calls, set variables in the pi-web server environment and use a supervised restart plus resource reload when appropriate; do not disrupt an active modeling/inference job. Unset `PI_HUNYUAN_COMFY_ROOT` to disable generation without hiding discovery.

Backend unit tests (no model load):

```sh
python3 -m unittest discover -s examples/pi-web-extensions/3d-modeling/hunyuan -p 'test_*.py' -v
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_MODELING_CONFIG` | Trusted generic runtime JSON file; defaults to `~/.pi/modeling.json` |
| `PI_HUNYUAN_COMFY_ROOT` | Opt-in absolute ComfyUI checkout path; unset disables generation, not discovery; no default |
| `PI_HUNYUAN_PYTHON` | Absolute Python interpreter for runner and ComfyUI; defaults to `<PI_HUNYUAN_COMFY_ROOT>/.venv/bin/python`; does not enable the tool alone |
| `PI_WEB_FUSION_MCP_URL` | Fusion MCP URL; defaults to `http://127.0.0.1:27182/mcp` and must remain HTTP loopback |
| `PRUSA_SLICER_PATH` | Explicit PrusaSlicer executable |
| `PRUSA_SLICER_DATADIR` | Optional configuration directory used by the STL artifact action |
| `PRUSA_SLICER_PRINTER_PROFILE` | Artifact-action printer profile override |
| `PRUSA_SLICER_PRINT_PROFILE` | Artifact-action print profile override |
| `PRUSA_SLICER_MATERIAL_PROFILE` | Artifact-action material profile override |

The action defaults target a Prusa MINI/MINI+ Input Shaper printer, the 0.20 mm SPEED print preset, and Generic PLA. Exact preset names vary by PrusaSlicer installation; override them when necessary.

## STL preview controls

The full-detail viewer preserves every source triangle, including coincident and degenerate faces, without clustering, welding or decimation. It uses PR277's original neutral grey **flat shading**, orthographic camera, lighting, radial ground/grid/shadow and bounded box, with the original horizontal orbit direction and zoom limits; vertical orbit follows the finger when pulling the model up/down. The original `stlEnvironment` and `stlFloorFactor` routines remain the canonical scene implementation. Info includes explicit **Up axis: Z / Y**: Z-up is the fabrication default, not a standard or inferred STL metadata; Y-up reproduces the original scene convention. A right-handed orthonormal viewing basis transforms positions/normals and environment bounds consistently without rewriting source GPU buffers. Ground, grid and box can be toggled. Camera presets, keyboard navigation and touch navigation remain available. Optional **Feature edges · 35°** restores true crease/boundary outlines without a global in-tab graph. It starts only after the exact model finishes loading **and** the user enables the direct Outlines checkbox in the compact toolbar; the model remains interactive during generation, and unchecking cancels it. The toolbar exposes only Fit, a compact View preset picker, and Outlines. Fit and keyboard F reset orbit, pan and zoom without changing the up axis. The current preset is indicated until manual orbit changes it. Info and Unload are separately labelled controls: Info describes the source and secondary display settings; Unload releases the model. Surface and Light selectors are omitted because only the original gray surface and neutral lighting are supported. Smooth/CAD shading and transparency remain unavailable.

Feature extraction runs in an owned server worker using fixed-size, sorted 72-byte edge-record runs and a bounded k-way merge, then streams every resulting line through a separate selected-resource capability. Incidence-one boundary edges, incidence-other-than-two nonmanifold edges, and two-face edges with normal dot product below `cos(35°)` are retained; coplanar triangulation diagonals are not. There is no edge sampling or mesh decimation. Only topology keys use the original PR277 grid (`round((position - boundsMin) / (max(span, 1) * 1e-7))`); triangle positions and displayed geometry are untouched. Angles use normalized **unchanged source-face** cross products. Unlike PR277's first-representative welded-face normals, this can change classification arbitrarily close to 35° or on ill-conditioned/near-degenerate triangles. Clean shared-position fixtures match the original edge sets exactly. Faces collapsed by the topology weld do not contribute outline incidents, matching PR277; they remain in the exact displayed mesh. Other zero-area faces have a zero normal, as in the original edge rule.

Limits are explicit: one outline worker per server process; 1.5 GiB worst-case per-job scratch (rejected before run-file creation), 128 MiB final line output, and a private SHA-256/algorithm-version cache with a 512 MiB payload LRU cap, at most 256 entries (metadata reads capped at 8 KiB), and lazy 24-hour expiry. Output checksums reject corrupt cached records. Success, cancellation and failure remove owned scratch; startup reaps dead-process leftovers without touching live jobs. Cache keys incorporate source bytes and source-normal/weld semantics; both streaming hashes and nanosecond stat identities reject a source modified during generation. Authorization still binds each request to the invoking session's originally selected source and renderer; content-addressed cache reuse never grants a new URL or exposes credentials. A full cache hit still hashes the source, validates the cached output and checks the source identity.

Measured on the exact 207,486,284-byte, 4,149,724-triangle angel: 90,776 crease edges (no boundary or nonmanifold edges), 2,178,624-byte output, about 3.7 seconds standalone generation, approximately 857 MiB temporary disk and 116 MiB standalone-process peak RSS. Explicit sorting/I/O buffers were approximately 47 MiB; this is not a claim that total process memory is 47 MiB. Server/browser/device baselines add overhead. Memory and scratch scale with fixed run budgets, not an object graph of all edges.

Above 20 MiB, the host shows the actual file size and a memory/tab-crash warning with **Load full model** and **Cancel**. Only a one-byte metadata probe happens before confirmation: no full-file loading, parsing or GPU allocation. Loading shows byte progress and supports cancellation; **Unload** releases the iframe and GPU memory. Reopening requires confirmation again.

## Security and limits

Artifact paths are decoded, validated, and checked by real path to prevent traversal and symlink escapes. Screenshot and slicing writes use pi's canonical per-file mutation queue, temporary files, and atomic rename so they coordinate with built-in `write` and `edit` tools. G-code previews accept at most 12 MB and retain roughly 50,000 compact, quantized path segments, with feature quotas that preserve about 48 or more samples per external-perimeter run. Separate Layer/Z and in-layer Move controls provide source-line detail, while Layer and Accumulated display modes keep shells readable. The viewer includes all source layer markers, G2/G3 arc tessellation, object/bed framing, the complete start/purge track, a physical 180 × 180 mm Prusa MINI bed at Z=0, feature colors, travel/full-track toggles, and unrestricted above/below-bed orbit. STL previews opt into the host's selected-artifact binary stream. Existing authenticated, session-scoped artifact routes stream from disk; credentials never enter the opaque sandbox. A private MessageChannel transfers at most two acknowledged 1 MiB chunks (a 2 MiB credit window). `stl-runtime.js` decodes binary or line-oriented ASCII STL incrementally, uploads fixed 8,192-triangle GPU batches and retains no full CPU-side mesh. The HTML response remains below 1 MB regardless of STL size. GPU storage is roughly 72 bytes per triangle (about 285 MiB for 4.15 million triangles), plus browser/driver overhead; device limits can still cause failure or a tab crash. Non-finite coordinates, incomplete models and GPU allocation errors fail visibly rather than dropping triangles. No former 20 MB source limit or automatic simplification remains. Host and extension must be upgraded together; older hosts do not supply this opt-in stream. Slicing accepts a 64 MB STL and caps generated G-code at 256 MB with a three-minute timeout.

Fusion access is loopback-only. Screenshots are limited to 32–4096 pixels per dimension and 16 MB decoded PNG data, with bounded MCP responses and timeouts. **Fusion Python is not sandboxed:** an acknowledged script runs inside Fusion with the user's permissions and can modify documents or access files. Review every script before execution.

PrusaSlicer is launched directly with an argument array through the host executor or CLI subprocess adapter, never through a shell. The executable is selected from `PRUSA_SLICER_PATH`, known macOS application locations, then `PATH`; profile names are passed only through dedicated options and arbitrary arguments are not exposed.

## Install globally

From the pi-web repository root:

```sh
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD/examples/pi-web-extensions/3d-modeling" ~/.pi/web/extensions/3d-modeling
```

Install the general skill separately (symlinking keeps the example canonical):

```sh
mkdir -p ~/.pi/agent/skills
ln -sfn "$PWD/examples/pi-web-skills/3d-modeling" ~/.pi/agent/skills/3d-modeling
```

Review the extension and skill before installation. Run `/reload` in pi-web, or start a new session after installation, to advertise `modeling` and the skill. The directory's `index.ts` is the extension entry point. Installation/reload is an explicit step, not performed merely by editing this example.

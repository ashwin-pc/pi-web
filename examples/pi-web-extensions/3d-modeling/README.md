# 3D modeling extension

A shared modeling CLI with **one optional agent tool**, interactive `.stl` and `.gcode` previews, and a **Slice** browser action. The CLI and tool share one dispatcher and backend adapters; neither duplicates execution logic. Discovery is always available, even when a backend is unconfigured.

## CLI and tool

From this repository (Node >=24 and installed dependencies):

```sh
node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts help
node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts discover
node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts fusion capabilities
node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts fusion docs --json '{"searchPattern":"LoftSections.add","apiCategory":"member"}'
node --import tsx examples/pi-web-extensions/3d-modeling/cad/cli.ts fusion read --json '{"queryType":"activeCommand"}'
```

For another working directory, use the absolute path to this checkout's `cad/cli.ts` and `node --import /absolute/path/to/node_modules/tsx/dist/loader.mjs`. The current directory determines the artifact root. No global command installation or PATH changes are required.

The extension registers only `modeling`, taking `{ "args": ["help"] }` or any identical CLI argument vector. `help [command]` is the complete current command and parameter reference. Successful standalone commands emit JSON to stdout; failed commands emit JSON to stderr and exit nonzero. Exit codes: 1 backend/configuration failure, 2 invalid arguments, 124 timeout, 130 cancellation. `--timeout-ms` bounds an invocation. The CLI never asks for interactive input.

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

`PI_MODELING_CONFIG` selects a trusted JSON file, otherwise `~/.pi/modeling.json` is used. Paths are host configuration, not skill instructions. Example:

```json
{
  "version": 1,
  "runtimes": [{
    "id": "blender",
    "description": "Explicit locally installed Blender",
    "executable": "/absolute/path/to/blender",
    "args": ["--background", "--python", "{script}", "--", "{run}"],
    "scriptExtension": ".py",
    "requiredPaths": [],
    "timeoutMs": 120000
  }]
}
```

Placeholders replace whole arguments; `{artifacts}` is also supported. Runtime execution snapshots the source and records its SHA-256, runtime descriptor, redacted logs and result under a unique `modeling-runs/` artifact directory. It owns a POSIX process group and terminates group members on cancellation, timeout and leader exit. Windows execution fails closed. Deliberately detached descendants and persistent-service scripts are unsupported. Generic runtimes do not replace the owned-ComfyUI lifecycle or Fusion's document semantics.

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

The default **CAD** style uses neutral matte grey surfaces, crease-preserving normals and black, depth-tested feature outlines. **Smooth** uses area-weighted smooth shading; **Flat** shows each facet. All styles use neutral grey materials on an Architectural charcoal-gradient stage, with a fading world-space ground grid, soft grounding shadow, orbit-linked XYZ indicator and thin gold reference bounds. The information popup includes an independent **Bounding box** checkbox (on by default). The orthographic camera remains unrestricted: the ground smoothly fades near the horizon and disappears underneath, never writing depth or occluding the model. Bounds remain independent of ground visibility and opacity. Style, **Feature outlines**, and **Opacity** are independent and never reset the camera. Orbit by dragging, shift/right-drag to pan, wheel/pinch to zoom; the information button includes **Reset view**. On mobile, the style picker, outlines toggle and opacity slider share one compact bottom row; navigation instructions are tucked into the information popup instead of occupying a second row. Full accessible labels remain available. Settings last for this preview only (no browser storage or network dependencies).

Feature edges use a 35° crease threshold plus open/non-manifold boundaries, excluding coplanar triangulation diagonals. Polygon-offset surfaces prevent outline z-fighting. Transparency blends rear/interior surfaces back-to-front using camera-space triangle-centroid sorting (updated when orbit changes). This is an approximation for intersecting triangles, overlapping coplanar faces or cyclic overlap, not order-independent transparency. Outlines remain depth-tested against the nearest surface via a separate depth prepass, avoiding rear-edge clutter. Solid mode retains its unsorted fast path.

## Security and limits

Artifact paths are decoded, validated, and checked by real path to prevent traversal and symlink escapes. Screenshot and slicing writes use pi's canonical per-file mutation queue, temporary files, and atomic rename so they coordinate with built-in `write` and `edit` tools. G-code previews accept at most 12 MB and retain roughly 50,000 compact, quantized path segments, with feature quotas that preserve about 48 or more samples per external-perimeter run. Separate Layer/Z and in-layer Move controls provide source-line detail, while Layer and Accumulated display modes keep shells readable. The viewer includes all source layer markers, G2/G3 arc tessellation, object/bed framing, the complete start/purge track, a physical 180 × 180 mm Prusa MINI bed at Z=0, feature colors, travel/full-track toggles, and unrestricted above/below-bed orbit. STL previews accept files up to 20 MB and use compact indexed WebGL buffers. STL vertices are deduplicated into one compact payload; crease normals, feature edges and environment geometry are derived locally in the sandbox, with original area-weighted normals retained for Smooth mode. `stl-runtime.js` is the canonical readable browser runtime embedded server-side (no runtime imports or network requests); pure environment helpers live in `stl-environment.ts`. The response budget includes runtime bytes and is capped at 990,000 actual UTF-8 bytes. Very dense meshes are deterministically edge-clustered only as needed to keep the sandbox document below the 1 MB preview-response limit, and the viewer reports displayed/source triangle counts. Slicing accepts a 64 MB STL and caps generated G-code at 256 MB with a three-minute timeout.

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

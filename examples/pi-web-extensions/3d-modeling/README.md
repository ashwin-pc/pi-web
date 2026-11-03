# 3D modeling extension

A canonical pi-web example for a Fusion 360 → STL → PrusaSlicer → G-code workflow. It adds interactive `.stl` and `.gcode` artifact previews, Fusion MCP tools, a PrusaSlicer tool, and a **Slice** action on STL artifacts.

## Tools

- `fusion_status` checks the active Fusion MCP connection.
- `fusion_screenshot` writes a bounded PNG viewport capture beneath `.pi/web/artifacts`.
- `fusion_execute_script` reads an artifact-relative `.py` file (maximum 256 KB) and requires `mutateDocument: true`.
- `slice_stl` converts an artifact-relative STL to artifact-relative G-code. Printer, print, and material profiles are optional with the example's Prusa MINI/PLA defaults, and may be overridden explicitly. It accepts no arbitrary CLI arguments.

## Local image → 3D (Hunyuan3D 2.1)

`comfy_image_to_3d` accepts `image` (artifact-relative PNG/JPEG/WebP or artifact URL), optional `seed`, `steps` (1–50, default 30), and `resolution` (128 or 256, default 256). It writes a unique `image-to-3d/<run>/` artifact directory containing copied input, API workflow, logs, metadata, and downloadable **untextured GLB geometry**. This is the installed native Hunyuan3D blueprint with LoadImage and SaveGLB endpoints, not texture synthesis. Hidden surfaces are inferred; physical scale, watertightness and printability are not guaranteed. No Blender or downloads are involved. GLB is downloadable; this extension's interactive viewer currently supports STL, not GLB.

The backend reuses the owned-ComfyUI lifecycle and process-identification helpers from the sibling `../image/runner.py` example (no image models/runtime required). Install from this repository using the directory symlink below, or preserve that sibling file when copying examples; do not copy the 3D directory alone.

Disabled by default: set `PI_HUNYUAN_COMFY_ROOT` to the absolute path of your existing ComfyUI checkout to register the tool. There is no default checkout and registration starts no processes. Requires macOS, Pillow, native 3D nodes and `models/checkpoints/hunyuan_3d_v2.1.safetensors`. The checkout's `.venv/bin/python` launches both the runner and ComfyUI; `PI_HUNYUAN_PYTHON` overrides both with an absolute interpreter path containing those dependencies. Setting only the interpreter does not opt in. Uses macOS `memory_pressure` (at least 25% free) and refuses detected active ComfyUI processes. There is no global inference broker/lock; preflight can race unrelated image/video calls, so run these workloads sequentially. A per-runtime busy guard prevents overlapping calls to this tool.

Only the newly spawned loopback process group is stopped/reaped (SIGTERM followed by SIGKILL escalation), including workflow failure, timeout and cancellation. Existing services are never interrupted. Startup is bounded to three minutes, generation to one hour; input is limited to 25 MB/16 megapixels and output to 250 MB. Inputs and output real paths must stay inside the artifact tree. No process starts during registration. Set the variables in the pi-web server environment, restart the server, then run `/reload` in existing sessions to expose the opted-in tool. Unset `PI_HUNYUAN_COMFY_ROOT` and restart/reload to disable it.

Backend unit tests (no model load):

```sh
python3 -m unittest discover -s examples/pi-web-extensions/3d-modeling/hunyuan -p 'test_*.py' -v
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_HUNYUAN_COMFY_ROOT` | Opt-in absolute ComfyUI checkout path; unset disables `comfy_image_to_3d`; no default |
| `PI_HUNYUAN_PYTHON` | Absolute Python interpreter for runner and ComfyUI; defaults to `<PI_HUNYUAN_COMFY_ROOT>/.venv/bin/python`; does not enable the tool alone |
| `PI_WEB_FUSION_MCP_URL` | Fusion MCP URL; defaults to `http://127.0.0.1:27182/mcp` and must remain HTTP loopback |
| `PRUSA_SLICER_PATH` | Explicit PrusaSlicer executable |
| `PRUSA_SLICER_DATADIR` | Optional configuration directory used by the STL artifact action |
| `PRUSA_SLICER_PRINTER_PROFILE` | Artifact-action printer profile override |
| `PRUSA_SLICER_PRINT_PROFILE` | Artifact-action print profile override |
| `PRUSA_SLICER_MATERIAL_PROFILE` | Artifact-action material profile override |

The action defaults target a Prusa MINI/MINI+ Input Shaper printer, the 0.20 mm SPEED print preset, and Generic PLA. Exact preset names vary by PrusaSlicer installation; override them when necessary.

## Security and limits

Artifact paths are decoded, validated, and checked by real path to prevent traversal and symlink escapes. Screenshot and slicing writes use pi's canonical per-file mutation queue, temporary files, and atomic rename so they coordinate with built-in `write` and `edit` tools. G-code previews accept at most 12 MB and retain roughly 50,000 compact, quantized path segments, with feature quotas that preserve about 48 or more samples per external-perimeter run. Separate Layer/Z and in-layer Move controls provide source-line detail, while Layer and Accumulated display modes keep shells readable. The viewer includes all source layer markers, G2/G3 arc tessellation, object/bed framing, the complete start/purge track, a physical 180 × 180 mm Prusa MINI bed at Z=0, feature colors, travel/full-track toggles, and unrestricted above/below-bed orbit. STL previews accept files up to 20 MB and use compact indexed WebGL buffers. STL vertices are deduplicated with smooth area-weighted normals; very dense meshes are deterministically edge-clustered only as needed to keep the sandbox document below the 1 MB preview-response limit, and the viewer reports displayed/source triangle counts. Slicing accepts a 64 MB STL and caps generated G-code at 256 MB with a three-minute timeout.

Fusion access is loopback-only. Screenshots are limited to 32–4096 pixels per dimension and 16 MB decoded PNG data, with bounded MCP responses and timeouts. **Fusion Python is not sandboxed:** an acknowledged script runs inside Fusion with the user's permissions and can modify documents or access files. Review every script before execution.

PrusaSlicer is launched directly with an argument array through `pi.exec`, never through a shell. The executable is selected from `PRUSA_SLICER_PATH`, known macOS application locations, then `PATH`; profile names are passed only through dedicated options and arbitrary arguments are not exposed.

## Install globally

From the pi-web repository root:

```sh
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD/examples/pi-web-extensions/3d-modeling" ~/.pi/web/extensions/3d-modeling
```

Run `/reload` in pi-web, or restart the active session. The directory's `index.ts` is the extension entry point.

# 3D modeling extension

A canonical pi-web example for a Fusion 360 → STL → PrusaSlicer → G-code workflow. It adds interactive `.stl` and `.gcode` artifact previews, Fusion MCP tools, a PrusaSlicer tool, and a **Slice** action on STL artifacts.

## Tools

- `fusion_status` checks the active Fusion MCP connection.
- `fusion_screenshot` writes a bounded PNG viewport capture beneath `.pi/web/artifacts`.
- `fusion_execute_script` reads an artifact-relative `.py` file (maximum 256 KB) and requires `mutateDocument: true`.
- `slice_stl` converts an artifact-relative STL to artifact-relative G-code. Printer, print, and material profiles are optional with the example's Prusa MINI/PLA defaults, and may be overridden explicitly. It accepts no arbitrary CLI arguments.

## Configuration

| Variable | Purpose |
| --- | --- |
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

# Optional local Qwen Image 2.1 tool (macOS)

This **example Pi extension is opt-in**, not bundled with pi-web's server or automatically registered. It requires a separately provisioned, trusted, isolated ComfyUI runtime and licensed model weights; neither weights nor a Python environment ship in this repository.

## Install and configure

1. Choose a runtime directory and set `PI_IMAGE_RUNTIME_ROOT` in the environment **before starting Pi**. The directory must contain `venv/bin/python`, `ComfyUI/main.py`, and the dependencies for ComfyUI, Pillow and PyTorch. Example: `export PI_IMAGE_RUNTIME_ROOT="$HOME/.local/share/qwen-image-2.1-comparison"` (adjust to your own installation). ComfyUI must include the `TextEncodeQwenImage21`, `UNETLoader`, `LoraLoaderModelOnly`, and `KSampler` nodes; install the GGUF custom node providing `UnetLoaderGGUF` for UC modes.
2. Copy `custom_nodes/pi_qwen21/` into `$PI_IMAGE_RUNTIME_ROOT/ComfyUI/custom_nodes/pi_qwen21/` **as a unit with this extension and runner**. Restart the isolated ComfyUI process if it was running. This custom node fixes MPS temporal zero-padding in the Qwen 2.1 VAE and implements the 64-channel latent and Viggle dynamic flow schedule; do not install an older copy alongside it.
3. Place these files (including `index.ts` and `runner.py`) together in a personal Pi extension directory, e.g. `~/.pi/agent/extensions/image/`, or load `index.ts` directly with `pi --extension /path/to/index.ts`. Pi supplies `typebox` and `@earendil-works/pi-coding-agent` imports. Do **not** put the extension in a pi-web project's autoload path unless you want it active there.
4. Provision licensed weights under `$PI_IMAGE_RUNTIME_ROOT/ComfyUI/models/`: `diffusion_models/qwen_image_2.1_bf16.safetensors`, `diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf`, `text_encoders/qwen3vl_8b_bf16.safetensors`, `vae/qwen_image_2.1_vae_bf16.safetensors`, `loras/Qwen-Image-2.1-viggle-turbo-4step-r64-comfyui-T8.safetensors`. Verify model provenance and licenses yourself. The selected mode's required files are checked before inference.
5. Remove or disable old registrations (`comfy-image-generate`, `comfy-image-edit`, `qwen-image`) **manually** if replacing them. `/reload` or a fresh session is required to refresh registered tools; this PR does not modify personal settings or active sessions.

## Use

`image({prompt:"A watercolor lighthouse"})` generates with `quick` (BF16 + Viggle four-step). Modes: `quality` (BF16, 40 steps), `uc-quick` (GGUF Q4 + Viggle four-step), `uc-quality` (GGUF Q4, 40 steps). Provide `image_path` plus up to two `reference_image_paths` for editing/composition. For independent sequential jobs, supply `jobs:[{prompt,seed,width,height}, ...]` with optional shared top-level `prompt`. Top-level image/seed/dimensions cannot mix with jobs. Generation defaults to 1024×1024; edit canvas follows the primary image aspect ratio. Paths resolve against the session working directory. Width/height are multiples of 32, from 256 to 2048.

Each job starts and stops its own loopback-only ComfyUI process, unloading weights; results, copied input images, workflow, request (including prompts and local paths), logs and errors persist in `.pi/web/artifacts/image/<run-id>/`. Treat these artifacts as private and remove sensitive ones yourself. A cancellation sends SIGTERM to the runner, which terminates its ComfyUI process group, escalating to SIGKILL if needed. macOS `memory_pressure` (minimum 25% free) and active-ComfyUI process checks run before loading weights; no cross-session lock exists, so concurrent calls can race. Unsupported platforms fail closed on memory preflight.

## Verification

From repo root: `node --import tsx --test examples/pi-web-extensions/image/test.ts` and `python3 -m unittest discover -s examples/pi-web-extensions/image -p test_runner.py`. The Python tests run workflow generation without model weights and test torch padding parity when torch is installed; they do not test image fidelity or MPS inference. The isolated runtime's `venv/bin/python` can be used for torch parity. Do not run ComfyUI inference just to execute these tests.

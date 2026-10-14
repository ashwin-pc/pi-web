# Local dictation

A pi-web-only composer action that records in the browser, transcribes through an extension-owned local runtime, and inserts text at the current selection. Core pi-web remains model-agnostic: it owns authenticated capture and temporary-file lifetime; this example owns models, Python dependencies, runtime checks, and inference. Transcription runs on the server, not a hosted transcription service. **Optional Photon uses an extension-owned telemetry-blocking shim:** unmodified Kestrel 0.8.0 sends mandatory usage telemetry to `api.moondream.ai` with no supported opt-out. This extension disables that reporter only for audited package versions/source hashes and refuses inference if verification fails. Model downloads still use the network; this is not a claim of network-private or offline operation. See Privacy before selecting it.

## Platform support

| Family | Runtime | macOS Apple Silicon | macOS Intel | Linux | Windows | Default model |
| --- | --- | --- | --- | --- | --- | --- |
| Parakeet | MLX (`parakeet-mlx` 0.5.1) | Supported; default on this host | No | No | No | `mlx-community/parakeet-tdt-0.6b-v3` |
| Whisper | MLX (`mlx-whisper`) | Supported | No | No | No | `mlx-community/whisper-large-v3-turbo` |
| Whisper | faster-whisper/CTranslate2 | CPU supported | CPU supported; default | CPU supported; default | CPU supported; default | `large-v3-turbo` |
| Whisper | faster-whisper CUDA | Not applicable | Not applicable | Available only with a compatible NVIDIA/CUDA/cuDNN installation | Available only with a compatible NVIDIA/CUDA/cuDNN installation | User-selected |
| Parakeet | Photon (`moondream` 2.4.0) CPU, optional | arm64 wheels; inference unverified | No | x86_64 smoke-tested; aarch64 wheels, inference unverified | x86_64 wheels; inference unverified; no ARM64 | `moondream/parakeet-redux` |

CUDA is opt-in and is not exercised by this example's lightweight CI. Follow faster-whisper's current CUDA/cuDNN compatibility documentation; an installed Python package alone does not prove the GPU runtime is usable. This example does not claim native Windows support for NVIDIA NeMo and does not include a community ONNX Parakeet conversion.

`Runtime: Automatic` resolves to MLX on Apple Silicon. Fresh non-Apple hosts default to Whisper/faster-whisper on CPU. Parakeet with Automatic selected on another host fails clearly rather than silently switching families or selecting Photon. Photon is always an explicit selection; no existing defaults change. A blank model field is resolved only when a request starts, so changing family/runtime cannot carry an incompatible generated default. Explicit model values are always preserved.

### Existing settings migration

Schema v1 exposed `Parakeet MLX` and `Whisper MLX`. Migration preserves the selected family and explicit model and records `runtime=mlx`; it never silently changes an existing installation to a different engine. Consequently, copying old settings to a non-Apple host produces an actionable MLX platform error until the owner selects Whisper plus Automatic/faster-whisper and optionally clears the model field.

## Requirements and setup

- Python 3.10 or newer
- `ffmpeg` on `PATH` (the extension deliberately performs a bounded, protocol-restricted decode before inference)
- disk space outside the repository for model caches
- pi-web's `composer-input` / `capture` capability

`setup.py` is the canonical cross-platform installer. It creates `.venv`, upgrades pip, and installs only the chosen runtime; it does not download model weights.

macOS/Linux:

```sh
python3 setup.py parakeet-mlx            # Apple Silicon only
python3 setup.py whisper-mlx             # Apple Silicon only
python3 setup.py whisper-faster-whisper  # portable CPU baseline
python3 setup.py parakeet-photon         # optional Photon CPU; Python 3.10–3.14
```

Windows PowerShell or Command Prompt:

```powershell
py -3 setup.py whisper-faster-whisper
```

`setup.sh` remains a thin compatibility wrapper for existing macOS installs (`./setup.sh parakeet` and `./setup.sh whisper`). Runtime dependencies are deliberately separate under `adapters/<family>/<runtime>/requirements.txt`; there is no shared root requirements file because no dependency set applies to every runtime. The Apple-only `requirements.lock` is an optional reproducibility snapshot of the tested Parakeet MLX environment, not the cross-platform installer. On Apple Silicon, install that exact snapshot explicitly with `.venv/bin/python -m pip install -r requirements.lock`.

The default interpreter is `.venv/Scripts/python.exe` on Windows and `.venv/bin/python` elsewhere. Settings can point to another executable. An executable name without a path is resolved through the service `PATH`.

Install the extension from the repository root:

macOS/Linux symlink:

```sh
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD/examples/pi-web-extensions/dictation" ~/.pi/web/extensions/dictation
```

Windows PowerShell junction (no file duplication):

```powershell
New-Item -ItemType Directory -Force "$HOME/.pi/web/extensions" | Out-Null
New-Item -ItemType Junction -Path "$HOME/.pi/web/extensions/dictation" -Target "$PWD/examples/pi-web-extensions/dictation"
```

Alternatively copy the directory and repeat the copy when updating. Run `/reload` or restart pi-web after installation changes.

### Optional Parakeet/Photon

Install `parakeet-photon`, then choose **Model family: Parakeet**, **Runtime: Photon**, and **Device: CPU** in Dictation settings. Clear an old MLX model value to use `moondream/parakeet-redux`; explicit model IDs are preserved and must be recognized by Photon. This adapter does not promise arbitrary Hugging Face repositories or local MLX/NeMo model directories work with Photon.

The dependency file pins the inspected public API release `moondream==2.4.0` (Python >=3.10,<3.15), which brings Kestrel. On Linux/Windows, setup first installs `torch==2.14.1+cpu` from `https://download.pytorch.org/whl/cpu`; macOS uses standard PyPI Torch. CPU-wheel availability still depends on Python/architecture. A plain PyPI Moondream install on the Linux smoke host pulled large CUDA Torch dependencies and exhausted 1.9 GB of free disk; use the setup target rather than installing Moondream alone. CPU Torch, Kestrel kernels, pip caches, and model weights still require substantial disk space. Installing into an existing environment does not remove old CUDA dependency packages or cached downloads. Preflight requires both packages and moondream >=2.4.0 without importing providers or downloading weights. Setup, capabilities and preflight reject unsupported architectures before installation/inference: macOS arm64 (including Python's aarch64 alias), Windows x86_64/AMD64, and Linux x86_64/AMD64 or aarch64/arm64. These wheel checks are not a guarantee of native inference. CPU transcription uses the public API with the ambient API key explicitly disabled; the audited reporter shim is installed before this call:

```python
import moondream as md
from adapters.parakeet.photon.telemetry import disable_telemetry
disable_telemetry()  # extension-specific, fail-closed audit guard
with md.photon("moondream/parakeet-redux", device="cpu", api_key="") as speech:
    text = speech.transcribe(audio="capture.wav")["text"]
```

CPU is passed explicitly, not auto-selected. CUDA/MPS are not enabled for Photon in this example; the faster-whisper compute-type setting is ignored. The serial worker keeps one Photon context warm for the current model/device, releases it on model changes or inference errors, and closes it on normal worker exit. Cancellation kills the worker process and releases its resources; the next request reloads the model. Errors are surfaced without switching models or runtimes. Passing `api_key=""` ignores an ambient `MOONDREAM_API_KEY`, prevents sending it as authentication, and leaves the cloud adapter provider disabled. A separate audited shim blocks usage telemetry. The first request can download model assets and exceed the dictation timeout; prewarm on the server host outside capture if needed.

A real Linux x86_64 CPU smoke check with `moondream==2.4.0` and `torch==2.14.1+cpu` successfully transcribed the committed 3.306-second speech fixture: two consecutive production-worker requests took 8.857 seconds cold and 0.389 seconds warm for inference, plus 102/229 ms for decoding. These are single-host observations, not performance guarantees. Lightweight tests mock the public API, not native inference. macOS and Windows remain unverified despite registry availability: confirm package availability, model loading, transcription, and cleanup on your exact OS/architecture before use. No GPU support or untested platform is promised.

## Models, caches, and licenses

Weights are never bundled. A Hugging Face/model name downloads on first use to the runtime's external cache; a local model directory remains owner-managed. Parakeet's upstream model is NVIDIA Parakeet TDT 0.6B v3 under CC BY 4.0; preserve required attribution. faster-whisper is MIT, while selected Whisper model artifacts can have their own model-card terms. Photon resolves `moondream/parakeet-redux` through its own model registry/cache rather than MLX's cache; review that model's card and Moondream/Kestrel package terms separately. Review the exact model card before deployment.

## Privacy

**Upstream behavior:** unmodified Kestrel 0.8.0 POSTs usage telemetry to `https://api.moondream.ai/v1/photon/telemetry` at engine startup and every 60 seconds while warm, and flushes on shutdown. Reports include hostname, random instance ID, model, active GPU, request/error counts, and input/output token counts. There is no supported telemetry opt-out; an empty API key alone does not stop reporting. The inspected telemetry payload does not contain audio or transcript text.

**This extension's protection:** `adapters/parakeet/photon/telemetry.py` verifies exact `moondream==2.4.0` / `kestrel==0.8.0` versions and SHA-256 hashes of the audited factory/cache, reporter, and engine source. Before engine creation, it replaces only the engine's reporter binding with a no-op: no telemetry HTTP client, hostname collection, periodic task, or shutdown flush. It rejects unexpected sources, versions, an already-modified reporter, or a pre-existing engine; there is no unprotected fallback. The patch is process-wide within the dedicated dictation worker, not a modification of installed files or a global HTTP/socket block. `api_key=""` separately prevents ambient credentials and cloud adapters. Native-model downloads (including Hugging Face requests) are unchanged. This is telemetry prevention, not a guarantee against every upstream network request or a promise of offline inference.

This private-API shim is deliberately version-specific: upgrades require a fresh source audit and tests before changing pins/hashes. Lightweight tests verify fail-closed behavior; optional installed-package tests exercise the real reporter/engine initialization with mocked HTTP (including accelerated periodic reporting), without downloading weights. Direct use of `md.photon` outside this extension still has upstream telemetry and can incur the 10-second startup HTTP timeout.

## Architecture and security

The extension owns capture-content validation, safe FFmpeg decoding, silence detection, bounded queueing, cancellation, and cleanup; core only enforces the generic capture contract and temporary-file lifecycle. Provider/runtime code is isolated and loaded only after a fixed registry lookup. Settings cannot supply a module name or command.

The browser capture contract gives the extension a validated private temporary file only for the invocation. On POSIX, core and the worker enforce private owner/mode checks. On Windows, Node's per-user temporary directory ACL is inherited; the worker still rejects non-directories, symlinks, and junctions instead of interpreting synthetic Windows mode bits as POSIX permissions.

`worker.py` forces MIME-selected WebM, MP4, Ogg, or WAV demuxers, limits FFmpeg protocols to `file,pipe`, emits mono 16 kHz PCM16, and independently rejects decoded audio over 120 seconds. Runtime/platform/dependency preflight happens before decode or model loading.

Node owns a FIFO queue with capacity for three total active-plus-queued requests and dispatches one request at a time. The transcription timeout begins at dispatch, not while waiting in the queue. Cancelling a queued request removes only that request, leaving the warm worker and other requests intact. Cancelling or timing out the active request interrupts native work by killing the detached POSIX process group or invoking `taskkill.exe /PID <pid> /T /F` directly without a shell on Windows. Termination is bounded, temporary cleanup is retried, and queued requests continue on a replacement worker. Cached MLX/faster-whisper models and the warm Photon context reload after an interrupted active request.

Node and Python communicate through bounded JSON-lines stdio. Python retains a private, non-inheritable duplicate of the protocol output descriptor and redirects operating-system stdout to stderr; native library logging cannot contaminate protocol output. Worker stderr is separately bounded.

Hiding the browser tab stops a live microphone recording, but lets its upload and transcription finish. Pending microphone permission is cancelled; explicit Cancel, leaving the page, or switching sessions still cancels the operation. Result insertion retains the session/revision/selection checks. Changing model/runtime settings does not replace existing capture registrations; only a changed recording-duration policy requires re-registration.

## Adding a family/runtime adapter

The extension owner—not core pi-web—must:

1. create `adapters/<family>/<runtime>/adapter.py` with
   `transcribe(wav, model_id, log, *, device, compute_type) -> str`;
2. add a fixed `(family, runtime)` entry and dependency/platform metadata to `adapters/__init__.py`;
3. add a runtime-specific requirements file and setup target;
4. add compatible default-model/config validation in `adapters/config.ts`;
5. document supported OS/architecture, accelerator prerequisites, model IDs, caches, and licenses;
6. test unavailable-platform, missing-dependency, lazy-import, and mocked public runtime API behavior.

Do not put arbitrary import paths or install commands in settings. Do not claim a platform supported until that adapter/runtime combination is exercised there.

## Verification

Lightweight tests do not install inference packages or download weights:

```sh
python3 -m unittest -v test_worker.py test_setup.py test_smoke_fixture.py
npx vitest run --config examples/pi-web-extensions/dictation/vitest.config.ts
```

`test_smoke_fixture.py` always verifies the committed PCM fixture's exact metadata and non-empty samples, and exercises the production FFmpeg decode path when FFmpeg is available. The Linux portability CI job ensures FFmpeg is installed, so that decode check runs there rather than being silently skipped. Real ASR inference remains intentionally outside CI because it requires large model weights and runtime-specific hardware/dependencies. The repository's PR workflow runs the lightweight tests on macOS, Linux, and Windows; GPU inference and model downloads are not part of that matrix.

## Limitations

- Photon relies on a version/source-checked private-API shim to block upstream telemetry; incompatible packages refuse inference. Downloads still require network access, and unmodified Photon outside the extension still reports usage.
- Batch dictation only, not streaming.
- Transcription can be wrong; review consequential text.
- Cached models consume memory until the shared worker exits or is cancelled.
- The existing Parakeet smoke result covers Apple Silicon MLX only.
- The portable Whisper and optional Photon adapters' APIs are unit-tested with mocks; no weights are downloaded in CI.

# Local dictation

A pi-web-only composer action that records in the browser, transcribes through an extension-owned local runtime, and inserts text at the current selection. Core pi-web remains model-agnostic: it owns authenticated capture and temporary-file lifetime; this example owns models, Python dependencies, runtime checks, and inference. Audio and transcripts are not sent to a hosted transcription service.

## Platform support

| Family | Runtime | macOS Apple Silicon | macOS Intel | Linux | Windows | Default model |
| --- | --- | --- | --- | --- | --- | --- |
| Parakeet | MLX (`parakeet-mlx` 0.5.1) | Supported; default on this host | No | No | No | `mlx-community/parakeet-tdt-0.6b-v3` |
| Whisper | MLX (`mlx-whisper`) | Supported | No | No | No | `mlx-community/whisper-large-v3-turbo` |
| Whisper | faster-whisper/CTranslate2 | CPU supported | CPU supported; default | CPU supported; default | CPU supported; default | `large-v3-turbo` |
| Whisper | faster-whisper CUDA | Not applicable | Not applicable | Available only with a compatible NVIDIA/CUDA/cuDNN installation | Available only with a compatible NVIDIA/CUDA/cuDNN installation | User-selected |
| Parakeet | Other runtimes | Not included | Not included | Not included | Not included | — |

CUDA is opt-in and is not exercised by this example's lightweight CI. Follow faster-whisper's current CUDA/cuDNN compatibility documentation; an installed Python package alone does not prove the GPU runtime is usable. This PR does not claim native Windows support for NVIDIA NeMo and does not include a community ONNX Parakeet conversion.

`Runtime: Automatic` resolves to MLX on Apple Silicon. Fresh non-Apple hosts default to Whisper/faster-whisper on CPU. Parakeet selected on another host fails clearly rather than silently switching families. A blank model field is resolved only when a request starts, so changing family/runtime cannot carry an incompatible generated default. Explicit model values are always preserved.

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
```

Windows PowerShell or Command Prompt:

```powershell
py -3 setup.py whisper-faster-whisper
```

`setup.sh` remains a thin compatibility wrapper for existing macOS installs (`./setup.sh parakeet` and `./setup.sh whisper`). Runtime dependencies are deliberately separate under `adapters/<family>/<runtime>/requirements.txt`; the Apple-only `requirements.lock` records the tested Parakeet MLX environment and must not be installed on Windows/Linux.

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

## Models, caches, and licenses

Weights are never bundled. A Hugging Face/model name downloads on first use to the runtime's external cache; a local model directory remains owner-managed. Parakeet's upstream model is NVIDIA Parakeet TDT 0.6B v3 under CC BY 4.0; preserve required attribution. faster-whisper is MIT, while selected Whisper model artifacts can have their own model-card terms. Review the exact model card before deployment.

## Architecture and security

The common worker owns capture validation, safe FFmpeg decoding, silence detection, bounded queueing, cancellation, and cleanup. Provider/runtime code is isolated and loaded only after a fixed registry lookup. Settings cannot supply a module name or command.

The browser capture contract gives the extension a validated private temporary file only for the invocation. On POSIX, core and the worker enforce private owner/mode checks. On Windows, Node's per-user temporary directory ACL is inherited; the worker still rejects non-directories, symlinks, and junctions instead of interpreting synthetic Windows mode bits as POSIX permissions.

`worker.py` forces MIME-selected WebM, MP4, Ogg, or WAV demuxers, limits FFmpeg protocols to `file,pipe`, emits mono 16 kHz PCM16, and independently rejects decoded audio over 120 seconds. Runtime/platform/dependency preflight happens before decode or model loading.

Node and Python communicate through bounded JSON-lines stdio. Cancellation kills the detached POSIX process group or invokes `taskkill.exe /PID <pid> /T /F` directly without a shell on Windows, waits for termination, then retries temporary-directory cleanup. One process-global worker keeps loaded models warm; cancelling one request currently aborts all requests pending on that worker.

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
python3 -m unittest -v test_worker.py test_setup.py
npx vitest run --config examples/pi-web-extensions/dictation/vitest.config.ts
```

The optional external-cache Parakeet smoke fixture remains `test-data/smoke.wav`; real inference is intentionally outside CI. The repository's PR workflow runs these lightweight tests on macOS, Linux, and Windows. GPU inference and model downloads are not part of that matrix.

## Limitations

- Batch dictation only, not streaming.
- Transcription can be wrong; review consequential text.
- Cached models consume memory until the shared worker exits or is cancelled.
- The existing Parakeet smoke result covers Apple Silicon MLX only.
- The portable Whisper adapter's API is unit-tested with mocks; no weights are downloaded in CI.

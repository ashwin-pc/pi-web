# Local dictation

A pi-web-only composer action that records in the browser, transcribes through a selected local adapter, and inserts the transcript at the current composer selection. Audio and transcripts are not sent to a hosted transcription service. Model weights are never stored in this extension or repository.

## Backends and models

The common worker owns capture validation, safe FFmpeg decoding, silence detection, queueing, cancellation, and cleanup. Provider code is isolated under `adapters/<backend>/` and loaded only when selected.

| Backend | Runtime | Tested/default model | Install |
| --- | --- | --- | --- |
| Parakeet | `parakeet-mlx` 0.5.1 | `mlx-community/parakeet-tdt-0.6b-v3` (tested revision `ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15`) | `./setup.sh parakeet` |
| Whisper | `mlx-whisper` | Choose a compatible MLX Whisper Hugging Face ID, for example `mlx-community/whisper-large-v3-turbo` | `./setup.sh whisper` |

Setup installs Python runtime packages only. A Hugging Face model ID downloads weights to the normal external cache (`~/.cache/huggingface/hub`) on first use; a local model path uses weights you manage elsewhere. Downloads and licenses are controlled by the selected model provider. Parakeet's upstream model is NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0); preserve its attribution and license when required. Whisper model licenses vary, so check the selected model card.

Changing **Backend** does not rewrite **Model ID or local model path**. Set both fields together. Models are loaded lazily and retained per backend/model combination for fast repeat dictation.

## Requirements and setup

- Apple Silicon Mac with macOS 13 or newer (both included adapters use MLX)
- Python 3.10+; Python 3.13 is tested
- `ffmpeg` on `PATH` (`brew install ffmpeg`)
- Disk space outside the repository for the selected model
- pi-web capture capability (`composer-input` / `capture`)

From this directory, install one or both adapter runtimes:

```sh
./setup.sh parakeet
# Optional, in the same environment:
./setup.sh whisper
```

`requirements.lock` is the complete tested Parakeet environment. Adapter-specific direct dependencies live beside each adapter. Whisper remains optional and therefore is not part of the Parakeet lock.

Install from the repository root:

```sh
mkdir -p ~/.pi/web/extensions
ln -sfn "$PWD/examples/pi-web-extensions/dictation" ~/.pi/web/extensions/dictation
```

Run `/reload` or restart pi-web after changing the installed extension. Settings appear under **Dictation**:

- backend (`Parakeet MLX` or `Whisper MLX`),
- model ID or external local model path,
- maximum recording length (1–120 seconds),
- transcription timeout (30–180 seconds),
- optional Python executable override (blank uses `.venv/bin/python`).

### Adding an adapter

Create `adapters/<name>/adapter.py`, add its fixed name/module mapping to `adapters/__init__.py`, and add a requirements file. The module must implement:

```python
def transcribe(wav: Path, model_id: str, log: Callable[[str], None]) -> str: ...
```

The registry is explicit: settings cannot import arbitrary modules or execute shell commands. Keep model weights and caches outside this directory.

## Architecture and privacy

The browser capture contract gives the extension a validated private temporary file and removes it after invocation. Node checks that it is an absolute, non-symlink regular file between 1 byte and 25 MB, creates a mode-0700 work directory, and always removes that directory.

`worker.py` forces MIME-selected WebM, MP4, Ogg, or WAV demuxers and restricts FFmpeg protocols to `file,pipe`. Decode output is bounded to 121 seconds of mono 16 kHz PCM16 and independently rejected above 120 seconds. A cheap RMS gate rejects silent recordings before loading provider code.

Node and Python use private stdin/stdout JSON lines with bounded output and no listening port. One process-global worker serves session-scoped extension instances. Requests are serialized with at most three outstanding reservations. Cancellation or timeout kills the detached process group, including FFmpeg, rejects every pending request, reaps the worker, and starts cleanly next time. Cancelling one request consequently aborts all requests pending on that shared worker.

## Verification

```sh
.venv/bin/python -m unittest -v test_worker.py
npx vitest run --config examples/pi-web-extensions/dictation/vitest.config.ts
```

`test-data/smoke.wav` is a 3.306-second mono 16 kHz PCM fixture. A Parakeet smoke run previously returned “Parakeet dictation is working locally on Apple Silicon.” Real inference is intentionally not part of unit tests because it requires externally managed weights.

## Limitations

- This is batch dictation, not live streaming.
- Transcription can be wrong; review consequential text.
- Cached models consume memory until pi-web exits or the worker is killed.
- The Whisper adapter follows `mlx-whisper`'s public `transcribe(..., path_or_hf_repo=...)` API but has not been model-smoke-tested in this checkout unless explicitly reported alongside a release.

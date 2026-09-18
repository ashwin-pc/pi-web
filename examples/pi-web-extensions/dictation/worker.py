#!/usr/bin/env python3
"""Private JSON-lines worker for local, adapter-backed transcription."""

from __future__ import annotations

from array import array
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
from typing import Any
import wave

from adapters import get_adapter

DEFAULT_BACKEND = "parakeet"
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
MAX_BACKEND_CHARS = 32
MAX_MODEL_CHARS = 256
MAX_INPUT_BYTES = 25_000_000
MAX_AUDIO_SECONDS = 120
MIN_RMS = 0.0015  # roughly -56.5 dBFS; rejects silence before model inference
FFMPEG_DECODE_LIMIT_SECONDS = 121
FFMPEG_TIMEOUT_SECONDS = 45
INPUT_FORMATS = {
    "audio/webm": "matroska",
    "audio/mp4": "mov",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}

def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def bounded_string(value: object, name: str, default: str, max_chars: int) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    value = value.strip()
    if len(value) > max_chars or "\x00" in value:
        raise ValueError(f"{name} is invalid or exceeds {max_chars} characters")
    return value


def validate_input(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("path must be a non-empty string")
    path = Path(raw_path)
    if not path.is_absolute():
        raise ValueError("capture path must be absolute")
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError("capture path must be a regular, non-symlink file")
    if info.st_size <= 0:
        raise ValueError("capture is empty")
    if info.st_size > MAX_INPUT_BYTES:
        raise ValueError(f"capture exceeds {MAX_INPUT_BYTES} bytes")
    return path


def validate_work_dir(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("workDir must be a non-empty string")
    path = Path(raw_path)
    if not path.is_absolute():
        raise ValueError("workDir must be absolute")
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ValueError("workDir must be a real directory")
    # The Node host creates this per invocation with mode 0700 and owns cleanup.
    if info.st_mode & 0o077:
        raise ValueError("workDir must not be accessible by group or other users")
    return path


def input_format(raw_mime_type: object) -> str:
    if not isinstance(raw_mime_type, str):
        raise ValueError("mimeType is required")
    mime_type = raw_mime_type.split(";", 1)[0].strip().lower()
    try:
        return INPUT_FORMATS[mime_type]
    except KeyError as error:
        raise ValueError(f"unsupported audio MIME type: {mime_type!r}") from error


def decode_audio(source: Path, destination: Path, demuxer: str) -> float:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found on PATH")
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        # Force a single intended container demuxer and disallow network,
        # playlists, crypto, and nested protocol fetches.
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        demuxer,
        "-i",
        os.fspath(source),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        str(FFMPEG_DECODE_LIMIT_SECONDS),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        os.fspath(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("audio decoding timed out") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip()[-1000:]
        raise RuntimeError(f"ffmpeg could not decode the recording: {detail or 'unknown error'}") from error

    with wave.open(os.fspath(destination), "rb") as decoded:
        if decoded.getnchannels() != 1 or decoded.getframerate() != 16000 or decoded.getsampwidth() != 2:
            raise RuntimeError("decoded audio is not mono 16 kHz PCM16")
        duration = decoded.getnframes() / decoded.getframerate()
    if duration <= 0:
        raise RuntimeError("decoded audio is empty")
    if duration > MAX_AUDIO_SECONDS:
        raise ValueError(f"recording exceeds {MAX_AUDIO_SECONDS} seconds")
    return duration


def ensure_audible(path: Path) -> None:
    with wave.open(os.fspath(path), "rb") as decoded:
        samples = array("h", decoded.readframes(decoded.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise RuntimeError("decoded audio is empty")
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768.0
    if rms < MIN_RMS:
        raise RuntimeError("recording is silent or too quiet")


def transcribe(path: Path, work_dir: Path, demuxer: str, backend: str, model_id: str) -> dict[str, object]:
    started = time.monotonic()
    wav = work_dir / "capture.wav"
    if wav.exists():
        raise ValueError("workDir is not empty")
    duration = decode_audio(path, wav, demuxer)
    ensure_audible(wav)
    decoded_at = time.monotonic()
    adapter = get_adapter(backend)
    text = adapter.transcribe(wav, model_id, log).strip()
    if not text:
        raise RuntimeError("no speech was recognized")
    finished = time.monotonic()
    return {
        "text": text,
        "model": model_id,
        "backend": backend,
        "durationMs": round(duration * 1000),
        "decodeMs": round((decoded_at - started) * 1000),
        "inferenceMs": round((finished - decoded_at) * 1000),
    }


def handle(message: object) -> dict[str, object]:
    if not isinstance(message, dict):
        raise ValueError("request must be an object")
    request_id = message.get("id")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("request id must be a non-empty string")
    operation = message.get("op")
    if operation == "ping":
        return {"id": request_id, "ok": True, "backends": ["parakeet", "whisper"]}
    if operation != "transcribe":
        raise ValueError(f"unsupported operation: {operation!r}")
    return {
        "id": request_id,
        "ok": True,
        **transcribe(
            validate_input(message.get("path")),
            validate_work_dir(message.get("workDir")),
            input_format(message.get("mimeType")),
            bounded_string(message.get("backend"), "backend", DEFAULT_BACKEND, MAX_BACKEND_CHARS),
            bounded_string(message.get("model"), "model", DEFAULT_MODEL, MAX_MODEL_CHARS),
        ),
    }


def main() -> int:
    protocol_stdout = sys.stdout
    for line in sys.stdin:
        request_id: object = None
        try:
            message = json.loads(line)
            request_id = message.get("id") if isinstance(message, dict) else None
            # Third-party import chatter must never corrupt the stdout protocol.
            with open(os.devnull, "w") as sink:
                sys.stdout = sink
                response = handle(message)
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}
        finally:
            sys.stdout = protocol_stdout
        protocol_stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        protocol_stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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

from adapters import capabilities, get_adapter, preflight

DEFAULT_FAMILY = "parakeet"
DEFAULT_RUNTIME = "mlx"
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
MAX_SETTING_CHARS = 256
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


def is_windows_reparse_point(info: os.stat_result) -> bool:
    """Detect junctions and other reparse points on Python 3.10+."""
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag or getattr(info, "st_reparse_tag", 0))


def validate_private_directory(info: os.stat_result, host_name: str = os.name) -> None:
    if host_name == "posix":
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            raise ValueError("workDir must be owned by the current user")
        if info.st_mode & 0o077:
            raise ValueError("workDir must not be accessible by group or other users")


def validate_work_dir(raw_path: object) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError("workDir must be a non-empty string")
    path = Path(raw_path)
    if not path.is_absolute():
        raise ValueError("workDir must be absolute")
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ValueError("workDir must be a real directory")
    # Windows junctions are directory reparse points, not POSIX symlinks.
    # st_file_attributes is available on supported Python 3.10/3.11 too.
    if is_windows_reparse_point(info):
        raise ValueError("workDir must not be a junction or reparse point")
    # POSIX exposes meaningful owner/mode information. Windows temp isolation is
    # provided by the current user's inherited ACL; synthetic st_mode bits must
    # not be interpreted as POSIX group access.
    validate_private_directory(info)
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


def transcribe(path: Path, work_dir: Path, demuxer: str, family: str, runtime: str, model_id: str, device: str, compute_type: str) -> dict[str, object]:
    started = time.monotonic()
    # Fail on unsupported platforms or missing packages before decoding audio or
    # loading model weights. The registry is fixed and settings cannot import code.
    preflight(family, runtime)
    adapter = get_adapter(family, runtime)
    wav = work_dir / "capture.wav"
    if wav.exists():
        raise ValueError("workDir is not empty")
    duration = decode_audio(path, wav, demuxer)
    ensure_audible(wav)
    decoded_at = time.monotonic()
    text = adapter.transcribe(wav, model_id, log, device=device, compute_type=compute_type).strip()
    if not text:
        raise RuntimeError("no speech was recognized")
    finished = time.monotonic()
    return {
        "text": text,
        "model": model_id,
        "family": family,
        "runtime": runtime,
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
        return {"id": request_id, "ok": True, "capabilities": capabilities()}
    if operation != "transcribe":
        raise ValueError(f"unsupported operation: {operation!r}")
    return {
        "id": request_id,
        "ok": True,
        **transcribe(
            validate_input(message.get("path")),
            validate_work_dir(message.get("workDir")),
            input_format(message.get("mimeType")),
            bounded_string(message.get("family"), "family", DEFAULT_FAMILY, MAX_SETTING_CHARS),
            bounded_string(message.get("runtime"), "runtime", DEFAULT_RUNTIME, MAX_SETTING_CHARS),
            bounded_string(message.get("model"), "model", DEFAULT_MODEL, MAX_SETTING_CHARS),
            bounded_string(message.get("device"), "device", "cpu", MAX_SETTING_CHARS),
            bounded_string(message.get("computeType"), "computeType", "int8", MAX_SETTING_CHARS),
        ),
    }


def main() -> int:
    # Preserve a dedicated protocol descriptor, then redirect OS fd 1 itself.
    # Native libraries using write(1, ...) now join bounded stderr logging rather
    # than corrupting JSONL. This happens only in the executable worker, never on
    # module import (unit tests and embedders keep their process descriptors).
    protocol_fd = os.dup(1)
    os.set_inheritable(protocol_fd, False)
    os.dup2(2, 1)
    protocol_stdout = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)
    try:
        for line in sys.stdin:
            request_id: object = None
            try:
                message = json.loads(line)
                request_id = message.get("id") if isinstance(message, dict) else None
                response = handle(message)
            except Exception as error:
                response = {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}
            protocol_stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            protocol_stdout.flush()
    finally:
        protocol_stdout.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

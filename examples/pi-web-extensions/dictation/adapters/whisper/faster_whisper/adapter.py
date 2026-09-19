"""Portable Whisper adapter using faster-whisper/CTranslate2."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable
import time

_models: dict[tuple[str, str, str], Any] = {}


def transcribe(
    wav: Path,
    model_id: str,
    log: Callable[[str], None],
    *,
    device: str = "cpu",
    compute_type: str = "int8",
) -> str:
    key = (model_id, device, compute_type)
    model = _models.get(key)
    if model is None:
        started = time.monotonic()
        from faster_whisper import WhisperModel
        model = WhisperModel(model_id, device=device, compute_type=compute_type)
        _models[key] = model
        log(f"loaded whisper model {model_id} with faster-whisper/{device}/{compute_type} in {time.monotonic() - started:.2f}s")
    segments, _info = model.transcribe(str(wav), beam_size=5)
    # faster-whisper defers inference until this generator is consumed.
    return "".join(segment.text for segment in segments)

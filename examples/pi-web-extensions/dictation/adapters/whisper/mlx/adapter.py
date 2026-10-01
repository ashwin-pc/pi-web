"""Whisper MLX adapter. Model weights are resolved externally by Hugging Face."""

from __future__ import annotations

from pathlib import Path
from typing import Callable


def transcribe(wav: Path, model_id: str, _log: Callable[[str], None], **_options: object) -> str:
    try:
        import mlx_whisper
    except ImportError as error:
        raise RuntimeError("Whisper MLX runtime is not installed; run the extension setup for 'whisper-mlx'") from error
    result = mlx_whisper.transcribe(str(wav), path_or_hf_repo=model_id)
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str):
        raise RuntimeError("Whisper backend returned no transcript")
    return text

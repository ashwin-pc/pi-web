"""Parakeet MLX adapter. Model weights are resolved externally by Hugging Face."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable
import time

_models: dict[str, Any] = {}


def transcribe(wav: Path, model_id: str, log: Callable[[str], None], **_options: object) -> str:
    model = _models.get(model_id)
    if model is None:
        started = time.monotonic()
        try:
            from parakeet_mlx import from_pretrained
        except ImportError as error:
            raise RuntimeError("Parakeet MLX runtime is not installed; run the extension setup for 'parakeet-mlx'") from error
        model = from_pretrained(model_id)
        _models[model_id] = model
        log(f"loaded parakeet model {model_id} in {time.monotonic() - started:.2f}s")
    return str(model.transcribe(wav).text)

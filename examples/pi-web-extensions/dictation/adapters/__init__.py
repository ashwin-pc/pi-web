"""Explicit registry for trusted local transcription adapters."""

from __future__ import annotations

from importlib import import_module
from types import ModuleType

_ADAPTERS = {
    "parakeet": "adapters.parakeet.adapter",
    "whisper": "adapters.whisper.adapter",
}


def get_adapter(name: str) -> ModuleType:
    """Load only a known adapter; configuration can never import arbitrary code."""
    module = _ADAPTERS.get(name)
    if module is None:
        raise ValueError(f"unknown dictation backend: {name!r}")
    return import_module(module)

"""Optional CPU Parakeet via Photon with an audited telemetry-blocking shim."""

from __future__ import annotations

import atexit
from pathlib import Path
import sys
from typing import Any, Callable

from .telemetry import disable_telemetry

# The worker dispatches requests serially. Keep only the current model warm,
# rather than retaining an unbounded collection of native engines.
_engine: tuple[tuple[str, str], Any, Any] | None = None


def _close(exc_info: tuple = (None, None, None)) -> None:
    global _engine
    engine, _engine = _engine, None
    if engine is not None:
        engine[1].__exit__(*exc_info)


atexit.register(_close)


def transcribe(path: Path, model_id: str, log: Callable[[str], None], *, device: str = "cpu", compute_type: str = "int8") -> str:
    global _engine
    # CPU is explicit: never let Photon auto-select a GPU or hosted backend.
    # compute_type belongs to faster-whisper and is intentionally not forwarded.
    if device != "cpu":
        raise ValueError("Parakeet Photon currently supports only device=cpu in this extension")
    key = (model_id, device)
    if _engine is not None and _engine[0] != key:
        _close()
    if _engine is None:
        try:
            import moondream as md
        except ImportError as error:
            raise RuntimeError("Parakeet Photon runtime is not installed; run python setup.py parakeet-photon") from error
        if not callable(getattr(md, "photon", None)):
            raise RuntimeError("Parakeet Photon requires moondream>=2.4.0; run python setup.py parakeet-photon")
        # Fail closed before engine initialization if the telemetry audit changes.
        disable_telemetry()
        # Own the public context manager for the warm engine's entire lifetime.
        # Inference uses the public API; only the audited reporter shim is private.
        # Empty key bypasses MOONDREAM_API_KEY and disables the cloud provider.
        # The separate audited reporter shim disables Kestrel usage telemetry.
        context = md.photon(model_id, device="cpu", api_key="")
        speech = context.__enter__()
        _engine = (key, context, speech)
    try:
        result = _engine[2].transcribe(audio=str(path))
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise RuntimeError("Parakeet Photon returned no text transcript")
        return result["text"]
    except BaseException:
        _close(sys.exc_info())
        raise

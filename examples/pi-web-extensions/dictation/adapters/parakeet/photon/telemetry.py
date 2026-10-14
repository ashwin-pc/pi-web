"""Audited, fail-closed telemetry shim for Moondream 2.4.0 / Kestrel 0.8.0.

Only the dedicated dictation worker uses this shim. It replaces the reporter
binding used by InferenceEngine, not HTTP/socket functions or model downloads.
Upstream has no supported telemetry switch. Re-audit before changing any pin.
"""

from __future__ import annotations

from hashlib import sha256
from importlib import import_module
from importlib.metadata import distribution
from typing import Any

# SHA-256 of the exact published Python source, not native/platform wheels.
# These cover the public factory, engine cache/key forwarding, and every
# reporter call site (startup, usage/error, periodic start, and shutdown).
_AUDITED = {
    "moondream": ("2.4.0", {
        "moondream/__init__.py": "f08d787c975bb312a752cc2ea136628ebde72e7c40e4f384650b4c3980d47d38",
        "moondream/photon_vl.py": "42331075c0884b09714c0ec7e12f400e8ea89c26b48adbc4b71eee9536ee0bfa",
    }),
    "kestrel": ("0.8.0", {
        "kestrel/photon.py": "064f5c6fddcb30fb2e2ac50850d2b07542185da0583ea6bf940c12b1272ff8ac",
        "kestrel/engine/core.py": "9947cfd5a927a49ce807d6173a975c454594c71c5613ae59373a47a7f4ad3428",
    }),
}


class _DisabledReporter:
    """No client, hostname collection, reporting task, or shutdown flush."""

    @staticmethod
    def _normalize_api_key(api_key: str | None) -> str | None:
        return (api_key or "").strip() or None

    @staticmethod
    def _is_api_key_header_safe(api_key: str) -> bool:
        return api_key.isascii() and all(not c.isspace() and c.isprintable() for c in api_key)

    def __init__(self, runtime_cfg: Any, runtime_device: Any, *, api_key: str | None, api_base_url: str) -> None:
        if self._normalize_api_key(api_key) is not None:
            raise RuntimeError("Dictation Photon requires an empty API key; cloud authentication is disabled")

    async def validate_api_key(self) -> bool:
        return False

    def start(self) -> None:
        pass

    def record_success(self, *, finetune: str | None, input_tokens: int, output_tokens: int) -> None:
        pass

    def record_error(self, *, finetune: str | None) -> None:
        pass

    async def shutdown(self) -> None:
        pass


def disable_telemetry() -> None:
    """Verify the audit, then patch before any Photon engine is initialized.

    Versions alone are insufficient: a locally modified source or an upstream
    change must not silently restore reporting. There is no unpatched fallback.
    """
    try:
        for package, (expected_version, sources) in _AUDITED.items():
            installed = distribution(package)
            if installed.version != expected_version:
                raise ValueError(f"requires {package}=={expected_version}, found {installed.version}")
            for relative, expected_hash in sources.items():
                if sha256(installed.locate_file(relative).read_bytes()).hexdigest() != expected_hash:
                    raise ValueError(f"unaudited source: {relative}")
        core = import_module("kestrel.engine.core")
        if core.PhotonReporter is _DisabledReporter:
            return
        photon = import_module("kestrel.photon")
        vl = import_module("moondream.photon_vl")
        if core.PhotonReporter is not photon.PhotonReporter or vl._engine_cache:
            raise ValueError("reporter already modified or Photon engine already initialized")
        core.PhotonReporter = _DisabledReporter
    except Exception as error:
        raise RuntimeError(f"Photon telemetry protection could not be verified; refusing inference: {error}") from error

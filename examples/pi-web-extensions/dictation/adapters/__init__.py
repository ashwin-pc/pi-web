"""Trusted transcription adapter registry and lightweight availability checks."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module, util
import platform
import sys
from types import ModuleType


@dataclass(frozen=True)
class AdapterSpec:
    module: str
    dependency: str
    setup_target: str
    platforms: tuple[str, ...]
    machines: tuple[str, ...] = ()


_ADAPTERS: dict[tuple[str, str], AdapterSpec] = {
    ("parakeet", "mlx"): AdapterSpec(
        "adapters.parakeet.mlx.adapter", "parakeet_mlx", "parakeet-mlx", ("darwin",), ("arm64", "aarch64")
    ),
    ("whisper", "mlx"): AdapterSpec(
        "adapters.whisper.mlx.adapter", "mlx_whisper", "whisper-mlx", ("darwin",), ("arm64", "aarch64")
    ),
    ("whisper", "faster-whisper"): AdapterSpec(
        "adapters.whisper.faster_whisper.adapter", "faster_whisper", "whisper-faster-whisper", ("darwin", "linux", "win32")
    ),
}


def _host() -> tuple[str, str]:
    return sys.platform.lower(), platform.machine().lower()


def get_spec(family: str, runtime: str) -> AdapterSpec:
    spec = _ADAPTERS.get((family, runtime))
    if spec is None:
        raise ValueError(f"unsupported dictation family/runtime: {family!r}/{runtime!r}")
    return spec


def preflight(family: str, runtime: str) -> AdapterSpec:
    spec = get_spec(family, runtime)
    system, machine = _host()
    if system not in spec.platforms or (spec.machines and machine not in spec.machines):
        supported = "macOS on Apple Silicon" if runtime == "mlx" else ", ".join(spec.platforms)
        raise RuntimeError(f"{family} with {runtime} is unavailable on {system}/{machine}; supported: {supported}")
    if util.find_spec(spec.dependency) is None:
        raise RuntimeError(
            f"{family} {runtime} runtime is not installed; run `python setup.py {spec.setup_target}` (Windows: `py -3 setup.py {spec.setup_target}`) in the extension directory"
        )
    return spec


def get_adapter(family: str, runtime: str) -> ModuleType:
    """Load only a fixed registry entry; settings cannot import arbitrary code."""
    return import_module(preflight(family, runtime).module)


def capabilities() -> list[dict[str, object]]:
    system, machine = _host()
    result = []
    for (family, runtime), spec in _ADAPTERS.items():
        platform_ok = system in spec.platforms and (not spec.machines or machine in spec.machines)
        result.append({
            "family": family,
            "runtime": runtime,
            "platformSupported": platform_ok,
            "installed": platform_ok and util.find_spec(spec.dependency) is not None,
            "setupTarget": spec.setup_target,
        })
    return result

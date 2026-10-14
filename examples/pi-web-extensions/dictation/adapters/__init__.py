"""Trusted transcription adapter registry and lightweight availability checks."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module, util
from importlib.metadata import PackageNotFoundError, version
import re
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
    minimum_version: tuple[int, int, int] | None = None
    extra_dependencies: tuple[str, ...] = ()
    platform_machines: tuple[tuple[str, tuple[str, ...]], ...] = ()

    def supports(self, system: str, machine: str) -> bool:
        machines = dict(self.platform_machines).get(system, self.machines)
        return system in self.platforms and (not machines or machine in machines)


_ADAPTERS: dict[tuple[str, str], AdapterSpec] = {
    ("parakeet", "mlx"): AdapterSpec(
        "adapters.parakeet.mlx.adapter", "parakeet_mlx", "parakeet-mlx", ("darwin",), ("arm64", "aarch64")
    ),
    ("parakeet", "photon"): AdapterSpec(
        "adapters.parakeet.photon.adapter", "moondream", "parakeet-photon", ("darwin", "linux", "win32"),
        minimum_version=(2, 4, 0), extra_dependencies=("kestrel",),
        platform_machines=(
            ("darwin", ("arm64", "aarch64")),
            ("win32", ("amd64", "x86_64")),
            ("linux", ("x86_64", "amd64", "aarch64", "arm64")),
        )
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


def _installed(spec: AdapterSpec) -> bool:
    # Metadata checks stay lightweight: no provider import or model download.
    if any(util.find_spec(name) is None for name in (spec.dependency, *spec.extra_dependencies)):
        return False
    if spec.minimum_version is not None:
        try:
            installed = version(spec.dependency)
        except PackageNotFoundError:
            return False
        match = re.match(r"^(\d+)\.(\d+)\.(\d+)(.*)$", installed)
        if match is None:
            return False
        release = tuple(int(part) for part in match.groups()[:3])
        if release < spec.minimum_version or (release == spec.minimum_version and re.match(r"^\.?(a|b|rc|dev)", match[4])):
            return False
    return True


def preflight(family: str, runtime: str) -> AdapterSpec:
    spec = get_spec(family, runtime)
    system, machine = _host()
    if not spec.supports(system, machine):
        if runtime == "mlx":
            supported = "macOS on Apple Silicon"
        elif spec.platform_machines:
            supported = ", ".join(f"{host} ({'/'.join(machines)})" for host, machines in spec.platform_machines)
        else:
            supported = ", ".join(spec.platforms)
        raise RuntimeError(f"{family} with {runtime} is unavailable on {system}/{machine}; supported: {supported}")
    if not _installed(spec):
        reason = "missing or incompatible (requires moondream>=2.4.0 and kestrel)" if runtime == "photon" else "not installed"
        raise RuntimeError(
            f"{family} {runtime} runtime is {reason}; run `python setup.py {spec.setup_target}` (Windows: `py -3 setup.py {spec.setup_target}`) in the extension directory"
        )
    return spec


def get_adapter(family: str, runtime: str) -> ModuleType:
    """Load only a fixed registry entry; settings cannot import arbitrary code."""
    return import_module(preflight(family, runtime).module)


def capabilities() -> list[dict[str, object]]:
    system, machine = _host()
    result = []
    for (family, runtime), spec in _ADAPTERS.items():
        platform_ok = spec.supports(system, machine)
        result.append({
            "family": family,
            "runtime": runtime,
            "platformSupported": platform_ok,
            "installed": platform_ok and _installed(spec),
            "setupTarget": spec.setup_target,
        })
    return result

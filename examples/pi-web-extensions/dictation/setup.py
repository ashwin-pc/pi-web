#!/usr/bin/env python3
"""Cross-platform runtime installer for the local dictation example."""

from __future__ import annotations

import argparse
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
TARGETS = {
    "parakeet-mlx": ROOT / "adapters/parakeet/mlx/requirements.txt",
    "whisper-mlx": ROOT / "adapters/whisper/mlx/requirements.txt",
    "whisper-faster-whisper": ROOT / "adapters/whisper/faster_whisper/requirements.txt",
}


def venv_python(root: Path = ROOT) -> Path:
    return root / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def validate_target(target: str) -> None:
    if target.endswith("-mlx") and not (sys.platform == "darwin" and platform.machine().lower() in {"arm64", "aarch64"}):
        raise SystemExit("MLX runtimes require macOS on Apple Silicon. Use whisper-faster-whisper on this host.")


def commands(target: str) -> list[list[str]]:
    python = venv_python()
    result: list[list[str]] = []
    if not python.exists():
        result.append([sys.executable, "-m", "venv", str(ROOT / ".venv")])
    result.extend([
        [str(python), "-m", "pip", "install", "--upgrade", "pip"],
        [str(python), "-m", "pip", "install", "-r", str(TARGETS[target])],
    ])
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("--dry-run", action="store_true", help="print commands without creating a venv or installing packages")
    parser.add_argument("--print-python", action="store_true", help="print the platform-specific venv interpreter path and exit")
    args = parser.parse_args()
    if args.print_python:
        print(venv_python())
        return 0
    validate_target(args.target)
    for command in commands(args.target):
        if args.dry_run:
            print(subprocess.list2cmdline(command))
        else:
            subprocess.run(command, cwd=ROOT, check=True, shell=False)
    if not args.dry_run:
        print(f"Ready: {args.target}. Model weights remain outside the extension and resolve on first use.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

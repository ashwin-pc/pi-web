#!/bin/sh
# Compatibility wrapper. setup.py is the canonical cross-platform installer.
set -eu
cd "$(dirname "$0")"
case "${1:-parakeet}" in
  parakeet) target=parakeet-mlx ;;
  whisper) target=whisper-mlx ;;
  parakeet-mlx|whisper-mlx|whisper-faster-whisper) target=$1 ;;
  *) printf 'usage: %s [parakeet-mlx|whisper-mlx|whisper-faster-whisper]\n' "$0" >&2; exit 2 ;;
esac
PYTHON=${PYTHON:-$(command -v python3 || command -v python)}
exec "$PYTHON" setup.py "$target"

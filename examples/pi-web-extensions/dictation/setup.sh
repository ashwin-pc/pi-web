#!/bin/sh
set -eu
cd "$(dirname "$0")"
BACKEND="${1:-parakeet}"
case "$BACKEND" in
  parakeet|whisper) ;;
  *) printf 'usage: %s [parakeet|whisper]\n' "$0" >&2; exit 2 ;;
esac
if [ ! -x .venv/bin/python ]; then
  PYTHON="${PYTHON:-$(command -v python3.13 || command -v python3)}"
  "$PYTHON" -m venv .venv
fi
.venv/bin/python -m pip install --upgrade pip
if [ "$BACKEND" = parakeet ]; then
  .venv/bin/python -m pip install -r requirements.lock
else
  .venv/bin/python -m pip install -r adapters/whisper/requirements.txt
fi
printf '%s\n' "Ready: $BACKEND runtime installed. Model weights are not bundled and resolve from the configured local path or external Hugging Face cache on first use."

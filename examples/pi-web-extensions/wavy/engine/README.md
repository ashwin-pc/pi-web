# Wavy local engine setup

Wavy does not install packages, alter environments, or download weights.

## YuE2 MLX

Set `WAVY_YUE_ROOT` to the existing `yue-local` checkout. It must contain `.venv/bin/python` and `backend/{bf16,4bit}`. BF16 is the default. YuE2 model licensing is non-commercial.

## Optional SheetSage2

SheetSage2 and MERT-v2-FullSong weights are **CC BY-NC 4.0** (non-commercial). In a separate Python 3.11 environment, install the requirements from a reviewed local SheetSage2 snapshot. Pin the snapshot to revision `80af707174fc7ee521c25925d5f014729f0e61ae`; its configuration pins the MERT parent revision `d8ba1c745e733b3908ce6ad16ebeb17ac7600a42`.

Set:

```sh
export WAVY_SHEETSAGE_PYTHON=/absolute/sheetsage-env/bin/python
export WAVY_SHEETSAGE_MODEL=/absolute/models/SheetSage2
export WAVY_SHEETSAGE_DEVICE=cpu # or mps, experimental
```

The snapshot must already be complete and include `config.json` and its reviewed remote-code Python. The bridge reports the expected reviewed revision separately from any `_commit_hash` actually present in the local config, plus the config SHA-256; it never claims an unverified snapshot is pinned. It calls `AutoModel.from_pretrained(..., trust_remote_code=True, local_files_only=True)` after forcibly setting `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, then invokes the official `model.transcribe()` API. Status only checks configuration/importability and never loads a model.

Before model loading, `ffprobe` must validate a real audio stream. Inputs are limited to 256 MiB, 10 minutes, 1–32 channels, and 8–384 kHz. Invalid or unprobeable containers are rejected before decoding. Transcription retains the model's raw files, timed events, ABC, request, result, and logs.

SheetSage2 does not transcribe lyrics and does not provide calibrated per-note confidence. Review its ABC and timed events before rendering with YuE2.

#!/usr/bin/env python3
"""Extension-owned staged adapter for the existing yue-local MLX backend.

It deliberately imports the backend implementation rather than copying inference code.
JSON request/result paths are supplied by engines.ts.
"""
from __future__ import annotations
import argparse, hashlib, json, os, sys, time, wave
from pathlib import Path


def atomic_json(path: Path, value):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def sha256(path: Path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""): h.update(chunk)
    return h.hexdigest()


def provenance(root: Path, model: Path, precision: str):
    files = [root / "backend" / name for name in ("generate.py", "yue2_model.py", "yue2_vae.py")]
    files.extend(model / name for name in ("yue2_generation_config.json", "config.json", "vae_config.json", "qwen.tiktoken"))
    fingerprints = {str(p.relative_to(root)): sha256(p) for p in files if p.is_file() and p.stat().st_size <= 10_000_000}
    identity = {"implementation": "npario/YuE2-3B-MLX", "precision": precision,
                "modelDirectory": str(model), "smallFileSha256": fingerprints}
    for candidate in (model / "revision.txt", model / "config.json"):
        if candidate.is_file():
            identity["snapshotMetadata"] = {"path": str(candidate), "sha256": sha256(candidate)}
            break
    return identity


def sampling_dict(value):
    return dict(value.__dict__)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--request", required=True)
    ap.add_argument("--result", required=True)
    args = ap.parse_args()
    root, request_path, result_path = Path(args.root).resolve(), Path(args.request), Path(args.result)
    req = json.loads(request_path.read_text())
    sys.path.insert(0, str(root / "backend"))
    import numpy as np
    import mlx.core as mx
    from generate import (Yue2Pipeline, Sampling, generate_tokens, token_prefix,
                          negative_prefix, synthesize, write_wav, CODEC_OFFSET,
                          SAMPLE_RATE)

    out = Path(req["outputDir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    precision = req["precision"]
    model = root / "backend" / precision
    started = time.perf_counter()
    log = lambda message: print(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "message": message}), flush=True)
    pipe = Yue2Pipeline(model, log=log)
    op, style, lyrics, cot, seed = req["operation"], req["style"], req["lyrics"], req["cot"], req["seed"]
    model_identity = provenance(root, model, precision)

    if op == "plan":
        log("generating symbolic plan")
        ids, truncated = generate_tokens(pipe.model, token_prefix(pipe.tokenizer, style, lyrics, cot),
            pipe.abc_sampling, seed, "abc", on_token=pipe._progress("abc"))
        score = pipe.tokenizer.decode(ids)
        prefix = token_prefix(pipe.tokenizer, style, lyrics, cot, ids)
        (out / "score.abc").write_text(score)
        np.save(out / "abc_tokens.npy", np.asarray(ids, dtype=np.int64))
        np.save(out / "prefix.npy", np.asarray(prefix, dtype=np.int64))
        effective = {"operation": "plan", "seed": seed, "cot": cot, "precision": precision,
                     "abcSampling": sampling_dict(pipe.abc_sampling),
                     "semanticSampling": None, "cfgScale": None, "odeSteps": None}
        plan = {"version": 1, "style": style, "lyrics": lyrics, "cot": cot, "seed": seed,
                "score": score, "abcTokens": len(ids), "truncated": truncated,
                "finishReason": "cap" if truncated else "eos", "effectiveConfiguration": effective,
                "model": model_identity}
        atomic_json(out / "plan.json", plan)
        result = {"status": "completed", "operation": op, "score": score,
                  "rawPlanPath": str(out / "plan.json"), "truncation": {"abc": truncated},
                  "finishReason": plan["finishReason"], "elapsedSeconds": time.perf_counter()-started,
                  "effectiveConfiguration": effective, "model": model_identity}
    else:
        abc = req.get("score")
        abc_ids = pipe.tokenizer.encode(abc) if abc is not None else []
        # The exact caller-provided score text is retained and is the only text tokenized here.
        if abc is not None:
            (out / "score.abc").write_text(abc)
        prefix = token_prefix(pipe.tokenizer, style, lyrics, cot, abc_ids)
        base = pipe.semantic_sampling.__dict__.copy()
        base.update(req.get("semanticSampling", {}))
        sampling = Sampling(**base)
        guidance = req.get("cfgScale", 1.01 if cot == "off" else 1.0)
        negative = negative_prefix(pipe.tokenizer, cot, abc_ids) if guidance != 1 else None
        ids, truncated = generate_tokens(pipe.model, prefix, sampling, seed, "semantic", negative,
            guidance, legacy_off=cot == "off", on_token=pipe._progress("semantic"))
        codec = [x-CODEC_OFFSET for x in ids]
        if not codec: raise RuntimeError("Semantic stage produced no codec tokens")
        np.save(out / "semantic.npy", np.asarray(codec, dtype=np.int64))
        effective_steps = req.get("steps") or pipe.ode_steps
        latents = synthesize(pipe.model, prefix, codec, seed, steps=effective_steps,
            on_progress=lambda i,n: i % 8 == 0 and log(f"acoustic step {i}/{n}"))
        np.save(out / "latents.npy", np.asarray(latents))
        audio = pipe.decode(latents)
        wav = out / "audio.wav"
        write_wav(wav, audio)
        frames = int(np.asarray(audio).shape[0])
        effective = {"operation": "render", "seed": seed, "cot": cot, "precision": precision,
                     "abcSampling": {"applicable": False, "configuration": sampling_dict(pipe.abc_sampling)},
                     "semanticSampling": sampling_dict(sampling), "cfgScale": guidance,
                     "odeSteps": effective_steps}
        result = {"status":"completed", "operation":op, "audioPath":str(wav), "wavPath":str(wav),
                  "durationSeconds":frames/SAMPLE_RATE, "elapsedSeconds":time.perf_counter()-started,
                  "finishReason":"cap" if truncated else "eos", "truncated":truncated,
                  "semanticTokens":len(codec), "effectiveConfiguration": effective, "model": model_identity}
    atomic_json(result_path, result)


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: raise SystemExit(130)

#!/usr/bin/env python3
"""Offline bridge for the reviewed m-a-p/SheetSage2 Transformers API.

This program never installs packages or downloads models. WAVY_SHEETSAGE_MODEL (or
request.modelPath) must name a complete local snapshot. Remote repository Python is
executed only from that caller-reviewed snapshot via trust_remote_code=True.
"""
from __future__ import annotations
import argparse, hashlib, importlib.util, json, os, subprocess, sys, time
from pathlib import Path
EXPECTED_REVISION="80af707174fc7ee521c25925d5f014729f0e61ae"
MAX_AUDIO_BYTES=256 * 1024 * 1024
MAX_AUDIO_SECONDS=600
LICENSE="CC-BY-NC-4.0"

def atomic(path,value):
    tmp=path.with_suffix(path.suffix+'.tmp'); tmp.write_text(json.dumps(value,indent=2,ensure_ascii=False)+"\n"); os.replace(tmp,path)
def file_sha256(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def snapshot_identity(path):
    config=path/'config.json'; actual=None
    try: actual=json.loads(config.read_text()).get('_commit_hash')
    except Exception: pass
    return {'expectedReviewedRevision':EXPECTED_REVISION,'actualRevision':actual,
            'configSha256':file_sha256(config) if config.is_file() else None}

def preflight_audio(path):
    size=path.stat().st_size
    if size < 1 or size > MAX_AUDIO_BYTES: raise ValueError(f'audio must be 1..{MAX_AUDIO_BYTES} bytes')
    command=['ffprobe','-v','error','-select_streams','a:0','-show_entries','stream=channels,sample_rate:format=duration','-of','json',str(path)]
    try: probe=subprocess.run(command,capture_output=True,text=True,timeout=20,check=True)
    except FileNotFoundError: raise RuntimeError('ffprobe is required for bounded audio validation')
    except (subprocess.SubprocessError,ValueError) as e: raise ValueError(f'audio container validation failed: {e}')
    try:
        data=json.loads(probe.stdout); stream=data['streams'][0]
        duration=float(data['format']['duration']); channels=int(stream['channels']); rate=int(stream['sample_rate'])
    except (KeyError,IndexError,TypeError,ValueError,OverflowError): raise ValueError('audio has no valid bounded audio stream metadata')
    if not (0 < duration <= MAX_AUDIO_SECONDS): raise ValueError(f'audio duration must be >0 and <= {MAX_AUDIO_SECONDS} seconds')
    if not (1 <= channels <= 32): raise ValueError('audio channels must be between 1 and 32')
    if not (8000 <= rate <= 384000): raise ValueError('audio sample rate must be between 8000 and 384000 Hz')
    return {'bytes':size,'durationSeconds':duration,'channels':channels,'sampleRate':rate}

def status():
    model=os.environ.get('WAVY_SHEETSAGE_MODEL',''); path=Path(model).expanduser() if model else None
    deps={name:importlib.util.find_spec(name) is not None for name in ('torch','transformers')}
    ready=bool(path and path.is_dir() and (path/'config.json').is_file() and all(deps.values()))
    missing=[]
    if not model: missing.append('WAVY_SHEETSAGE_MODEL is unset')
    elif not path.is_dir() or not (path/'config.json').is_file(): missing.append('local snapshot/config.json not found')
    missing += [f'{x} is not importable' for x,v in deps.items() if not v]
    identity=snapshot_identity(path) if path and (path/'config.json').is_file() else {'expectedReviewedRevision':EXPECTED_REVISION,'actualRevision':None,'configSha256':None}
    return {'available':ready,'inferenceValidated':False,'license':LICENSE,**identity,'modelPath':str(path) if path else None,
            'message':'Offline SheetSage2 bridge ready.' if ready else 'SheetSage2 unavailable: '+'; '.join(missing)+'. See engine/README.md.'}
def json_safe(value):
    try: json.dumps(value); return value
    except (TypeError,ValueError):
        if isinstance(value,dict): return {str(k):json_safe(v) for k,v in value.items()}
        if isinstance(value,(list,tuple)): return [json_safe(v) for v in value]
        if hasattr(value,'item'):
            try:return value.item()
            except Exception:pass
        return str(value)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--status',action='store_true');ap.add_argument('--root');ap.add_argument('--request');ap.add_argument('--result');a=ap.parse_args()
    if a.status: print(json.dumps(status()));return
    result_path=Path(a.result); req=json.loads(Path(a.request).read_text()); out=Path(req['outputDir']).resolve(); out.mkdir(parents=True,exist_ok=True)
    model=Path(req.get('modelPath') or os.environ.get('WAVY_SHEETSAGE_MODEL','')).expanduser().resolve()
    if not model.is_dir() or not (model/'config.json').is_file(): raise RuntimeError('WAVY_SHEETSAGE_MODEL must be a complete reviewed local snapshot')
    audio=Path(req['audioPath']).resolve()
    if not audio.is_file(): raise RuntimeError(f'audio input not found: {audio}')
    media=preflight_audio(audio)
    os.environ['HF_HUB_OFFLINE']='1'; os.environ['TRANSFORMERS_OFFLINE']='1'
    import torch
    from transformers import AutoModel
    device=os.environ.get('WAVY_SHEETSAGE_DEVICE','cpu')
    if device not in ('cpu','mps'): raise RuntimeError('WAVY_SHEETSAGE_DEVICE must be cpu or mps on this adapter')
    print(json.dumps({'time':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'message':f'Loading local SheetSage2 on {device}'}),flush=True)
    loaded=AutoModel.from_pretrained(str(model),trust_remote_code=True,local_files_only=True).eval().to(device)
    started=time.perf_counter()
    raw_dir=out/'raw'; raw_dir.mkdir(exist_ok=False)
    raw=loaded.transcribe(str(audio),output_dir=str(raw_dir),dtype='fp32',preset='default',melody_only=False,render_audio=False,render_score=False)
    score=raw.get('abc'); abc_error=raw.get('abc_error')
    if not score: raise RuntimeError(f'SheetSage2 produced no usable ABC: {abc_error or "unknown notation failure"}')
    events=raw.get('events',[])
    # Preserve the model's own raw events file; return its in-memory timed events too.
    envelope={'status':'completed','operation':'transcribe','score':score,'events':json_safe(events),
              'elapsedSeconds':time.perf_counter()-started,'modelPath':str(model),**snapshot_identity(model),
              'sourceMedia':media,
              'license':LICENSE,'warnings':json_safe(raw.get('warnings',[])),'abcError':abc_error,
              'rawResultPath':str(raw_dir/'result.json')}
    atomic(result_path,envelope)
if __name__=='__main__':
    try:main()
    except Exception as e:
        if '--result' in sys.argv:
            try:atomic(Path(sys.argv[sys.argv.index('--result')+1]),{'status':'failed','error':{'code':'SHEETSAGE_FAILED','message':str(e)}})
            except Exception:pass
        print(str(e),file=sys.stderr);raise SystemExit(3)

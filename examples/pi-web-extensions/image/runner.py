#!/usr/bin/env python3
"""Canonical isolated Qwen 2.1 ComfyUI runner. Usage: python qwen-tool-runner.py request.json."""
import json, os, pathlib, shutil, signal, socket, subprocess, sys, time, urllib.request, urllib.error, uuid

HOME = pathlib.Path(os.environ.get('PI_IMAGE_RUNTIME_ROOT', '')).expanduser().resolve() if os.environ.get('PI_IMAGE_RUNTIME_ROOT') else None
COMFY = HOME / 'ComfyUI' if HOME else None
WEIGHTS = COMFY / 'models' if COMFY else None
def safe_filename(value):
    if not isinstance(value, str) or not value or value in ('.', '..') or '/' in value or '\\' in value:
        raise ValueError('Model asset must be a filename within its ComfyUI model directory')
    return value

def profile_assets(profile):
    model = profile['model']
    if model['loader'] not in ('UNETLoader', 'UnetLoaderGGUF'):
        raise ValueError('Unsupported Qwen model loader')
    assets = [('diffusion_models', safe_filename(model['file'])),
              ('text_encoders', safe_filename(profile['textEncoder'])),
              ('vae', safe_filename(profile['vae']))]
    if profile.get('lora'):
        assets.append(('loras', safe_filename(profile['lora']['file'])))
    return assets

def edit_size(original_w, original_h, requested_resolution):
    """Mirror TextEncodeQwenImage21's resize exactly; choose a valid scalar, never distort the input."""
    import math
    if original_w <= 0 or original_h <= 0:
        raise ValueError('Edit image dimensions must be positive')
    ratio = original_w / original_h
    def dimensions(resolution):
        width = max(32, round(math.sqrt(resolution * resolution * ratio) / 32) * 32)
        height = max(32, round(math.sqrt(resolution * resolution / ratio) / 32) * 32)
        return width, height
    # The upstream encoder accepts a single scalar resolution (step 32); matching
    # its actual resize is essential because it also creates the sampling latent.
    candidates = [(abs(resolution - requested_resolution), resolution, *dimensions(resolution))
                  for resolution in range(32, 4097, 32)]
    for _, resolution, width, height in sorted(candidates):
        if 256 <= width <= 2048 and 256 <= height <= 2048:
            return resolution, width, height
    raise ValueError(f'Edit aspect ratio {original_w}:{original_h} cannot fit 256–2048 pixel sampling bounds without distortion; crop or pad the source image')

def workflow(req, inputs):
    profile = req['profile']
    profile_assets(profile)
    model_spec = profile['model']
    sampling = profile['sampling']
    loader = model_spec['loader']
    model_name = model_spec['file']
    w, h = req['width'], req['height']
    d = {
      'model': {'class_type': loader, 'inputs': {'unet_name': model_name, **({'weight_dtype': model_spec.get('weight_dtype', 'default')} if loader == 'UNETLoader' else {})}},
      'clip': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': profile['textEncoder'], 'type': 'qwen_image', 'device': 'default'}},
      'vae': {'class_type': 'PiQwen21VAELoader', 'inputs': {'vae_name': profile['vae']}},
      'encode': {'class_type': 'TextEncodeQwenImage21', 'inputs': {'clip': ['clip',0], 'vae': ['vae',0], 'prompt': req['prompt'], 'negative_prompt': '', 'resolution': req.get('edit_resolution', max(w,h))}},
      'decode': {'class_type': 'VAEDecode', 'inputs': {'vae': ['vae',0], 'samples': ['sample',0]}},
      'save': {'class_type': 'SaveImage', 'inputs': {'images': ['decode',0], 'filename_prefix': 'image-output'}},
    }
    for i, name in enumerate(inputs, 1):
        key = f'input_{i}'
        d[key] = {'class_type': 'LoadImage', 'inputs': {'image': name}}
        d['encode']['inputs'][f'images.image_{i}'] = [key,0]
    latent = ['encode',2] if inputs else ['latent',0]
    if not inputs:
        d['latent'] = {'class_type': 'PiQwen21EmptyLatent', 'inputs': {'width': w, 'height': h}}
    model = ['model',0]
    if profile.get('lora'):
        d['lora'] = {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': model, 'lora_name': profile['lora']['file'], 'strength_model': profile['lora']['strength']}}
        model = ['lora',0]
    if sampling['kind'] == 'viggle-flow':
        if sampling['steps'] != 4: raise ValueError('viggle-flow requires four steps')
        d.update({
          'noise': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': req['seed']}},
          'guider': {'class_type': 'CFGGuider', 'inputs': {'model': model, 'positive': ['encode',0], 'negative': ['encode',1], 'cfg': sampling['cfg']}},
          'sampler': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': sampling['sampler']}},
          'sigmas': {'class_type': 'PiViggleFlowSigmas', 'inputs': {'width': w, 'height': h}},
          'sample': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['noise',0], 'guider': ['guider',0], 'sampler': ['sampler',0], 'sigmas': ['sigmas',0], 'latent_image': latent}},
        })
    elif sampling['kind'] == 'standard':
        d['sample'] = {'class_type': 'KSampler', 'inputs': {'model': model, 'positive': ['encode',0], 'negative': ['encode',1], 'latent_image': latent, 'seed': req['seed'], 'steps': sampling['steps'], 'cfg': sampling['cfg'], 'sampler_name': sampling['sampler'], 'scheduler': sampling.get('scheduler', 'simple'), 'denoise': sampling.get('denoise', 1.0)}}
    else:
        raise ValueError('Unsupported Qwen sampling kind')
    return d

def api(port, path, data=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json'} if data is not None else {})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

def process_group_exists(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False

def stop_process_group(proc):
    # poll() may have reaped the leader, but a child can still hold the group.
    # Waiting on proc alone cannot detect that child or unload its weights.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            proc.wait(timeout=0)  # Reap the leader; a zombie also keeps the group visible.
        except subprocess.TimeoutExpired:
            pass
        if not process_group_exists(proc.pid):
            return
        time.sleep(0.2)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait(timeout=5)

def main(req):
    root = pathlib.Path(req['root']).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root/'input').mkdir(exist_ok=True)
    (root/'output').mkdir(exist_ok=True)
    (root/'user').mkdir(exist_ok=True)
    copied = []
    for i, src in enumerate(req['images'], 1):
        path = pathlib.Path(src).resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):
            raise ValueError('Inputs must be PNG, JPEG, or WebP files')
        name = f'input-{i}{path.suffix.lower()}'
        shutil.copyfile(path, root/'input'/name)
        copied.append(name)
    if copied:
        # TextEncodeQwenImage21 creates the edit latent at the first reference's
        # resized dimensions. Use its exact scalar/rounding for sigmas and latent.
        from PIL import Image
        with Image.open(root/'input'/copied[0]) as image:
            original_w, original_h = image.size
        req['edit_resolution'], req['width'], req['height'] = edit_size(original_w, original_h, max(req['width'], req['height']))
    flow = workflow(req, copied)
    (root/'workflow.json').write_text(json.dumps(flow, indent=2)+'\n')
    if req.get('dry_run'):
        print(json.dumps({'workflow': str(root/'workflow.json')}), flush=True)
        return
    # Preflight before any model weights are loaded. No cross-session inference lock by design.
    if HOME is None or not (HOME/'venv/bin/python').is_file() or not (COMFY/'main.py').is_file():
        raise RuntimeError('Set PI_IMAGE_RUNTIME_ROOT to an isolated runtime with venv/bin/python and ComfyUI/main.py')
    files = [WEIGHTS/folder/name for folder, name in profile_assets(req['profile'])]
    for f in files:
        if not f.is_file() or f.stat().st_size < 1000000: raise RuntimeError(f'Missing model weight: {f}')
    if sys.platform != 'darwin':
        raise RuntimeError('This runtime requires macOS memory_pressure; no safe preflight is available on this platform')
    vm = subprocess.run(['memory_pressure'], capture_output=True, text=True, check=True).stdout
    import re
    match = re.search(r'System-wide memory free percentage:\s*(\d+)', vm)
    if not match or int(match.group(1)) < 25: raise RuntimeError('Memory preflight: less than 25% free system memory')
    procs = subprocess.run(['ps','-axo','command'], capture_output=True, text=True, check=True).stdout
    if any('ComfyUI/main.py' in line or 'ComfyUI main.py' in line for line in procs.splitlines() if 'ps -axo' not in line):
        raise RuntimeError('Memory preflight: another ComfyUI process appears active; retry when idle')
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    log = open(root/'comfy.log', 'wb')
    proc = None
    try:
        proc = subprocess.Popen([str(HOME/'venv/bin/python'), str(COMFY/'main.py'), '--listen','127.0.0.1','--port',str(port),'--input-directory',str(root/'input'),'--output-directory',str(root/'output'),'--user-directory',str(root/'user')], cwd=COMFY, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic()+180
        while time.monotonic()<deadline:
            if proc.poll() is not None: raise RuntimeError(f'ComfyUI exited {proc.returncode}; inspect {root}/comfy.log')
            try:
                api(port, '/system_stats'); break
            except (urllib.error.URLError, TimeoutError): time.sleep(1)
        else: raise TimeoutError('ComfyUI startup timed out')
        result = api(port, '/prompt', {'client_id':str(uuid.uuid4()), 'prompt':flow})
        if 'prompt_id' not in result: raise RuntimeError(f'Workflow rejected: {result}')
        pid = result['prompt_id']; deadline = time.monotonic()+3600
        while time.monotonic()<deadline:
            if proc.poll() is not None: raise RuntimeError('ComfyUI stopped during inference')
            history = api(port, '/history/'+pid).get(pid)
            if history:
                status = history.get('status',{})
                if status.get('status_str') == 'error' or status.get('completed') is False: raise RuntimeError(f'Inference failed: {status}')
                images = [image for output in history.get('outputs',{}).values() for image in output.get('images',[])]
                if images:
                    paths = [(root/'output'/image.get('subfolder','')/image['filename']).resolve() for image in images]
                    if any(not str(p).startswith(str((root/'output').resolve())+'/') or not p.is_file() for p in paths): raise RuntimeError('Invalid/missing output paths')
                    print(json.dumps({'outputs':[str(p) for p in paths], 'prompt_id':pid, 'port':port}), flush=True)
                    return
            time.sleep(2)
        raise TimeoutError('Inference timed out')
    finally:
        try:
            if proc is not None:
                stop_process_group(proc)
        finally:
            log.close()

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt('Cancelled')))
    try: main(json.loads(pathlib.Path(sys.argv[1]).read_text()))
    except (Exception, KeyboardInterrupt) as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)

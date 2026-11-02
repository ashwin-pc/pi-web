"""Owned, loopback-only ComfyUI Hunyuan3D runner; no downloads or Blender."""
import json, os, pathlib, signal, socket, subprocess, sys, time, urllib.request, uuid


def workflow(image, seed, steps, resolution):
    def node(kind, **inputs): return {'class_type': kind, 'inputs': inputs}
    return {
        'image': node('LoadImage', image=image),
        'checkpoint': node('ImageOnlyCheckpointLoader', ckpt_name='hunyuan_3d_v2.1.safetensors'),
        'model': node('ModelSamplingAuraFlow', model=['checkpoint', 0], shift=1.0),
        'vision': node('CLIPVisionEncode', clip_vision=['checkpoint', 1], image=['image', 0], crop='center'),
        'conditioning': node('Hunyuan3Dv2Conditioning', clip_vision_output=['vision', 0]),
        'latent': node('EmptyLatentHunyuan3Dv2', resolution=4096, batch_size=1),
        'sample': node('KSampler', model=['model', 0], positive=['conditioning', 0], negative=['conditioning', 1], latent_image=['latent', 0], seed=seed, steps=steps, cfg=5.0, sampler_name='euler', scheduler='normal', denoise=1.0),
        'decode': node('VAEDecodeHunyuan3D', samples=['sample', 0], vae=['checkpoint', 2], num_chunks=8000, octree_resolution=resolution),
        'mesh': node('VoxelToMesh', voxel=['decode', 0], algorithm='surface net', threshold=0.6),
        'save': node('SaveGLB', mesh=['mesh', 0], filename_prefix='model'),
    }


def stop_owned(proc):
    if proc is None or proc.poll() is not None: return
    proc.terminate()
    try: proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def contained(root, value):
    path = pathlib.Path(value).resolve(strict=True)
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Output escapes owned directory or is not a file')
    return path


def api(port, path, data=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as response: return json.load(response)


def run(req):
    root = pathlib.Path(req['root']).resolve(strict=True)
    comfy = pathlib.Path(os.environ.get('PI_HUNYUAN_COMFY_ROOT', '/Users/ashwin/Documents/ComfyUI')).resolve()
    python = comfy / '.venv/bin/python'
    for required in [python, comfy/'main.py', comfy/'models/checkpoints/hunyuan_3d_v2.1.safetensors']:
        if not required.is_file(): raise RuntimeError(f'Missing installed dependency: {required}')
    from PIL import Image
    image_path = contained(root/'input', root/'input'/req['image'])
    with Image.open(image_path) as image:
        if image.width * image.height > 16_000_000: raise ValueError('Image exceeds 16 megapixels')
        image.verify()
    # Match installed image-tool preflight; never interrupt unrelated inference.
    commands = subprocess.check_output(['ps', '-axo', 'command'], text=True, timeout=15)
    if any(('main.py' in line and ('ComfyUI' in line or '--listen' in line)) for line in commands.splitlines()):
        raise RuntimeError('Another ComfyUI process is active; retry when idle (nothing was stopped)')
    pressure = subprocess.check_output(['memory_pressure'], text=True, timeout=15)
    import re
    match = re.search(r'System-wide memory free percentage:\s*(\d+)', pressure)
    if not match or int(match.group(1)) < 25: raise RuntimeError('Memory preflight requires at least 25% free memory')
    for directory in ['output', 'temp', 'user']: (root/directory).mkdir(exist_ok=True)
    flow = workflow(req['image'], req['seed'], req['steps'], req['resolution'])
    (root/'workflow.json').write_text(json.dumps(flow, indent=2)+'\n')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    proc = None
    def cancelled(*_): raise InterruptedError('Hunyuan3D cancelled')
    previous = {sig: signal.signal(sig, cancelled) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        with (root/'comfy.log').open('wb') as log:
            proc = subprocess.Popen([str(python), str(comfy/'main.py'), '--listen', '127.0.0.1', '--port', str(port), '--input-directory', str(root/'input'), '--output-directory', str(root/'output'), '--temp-directory', str(root/'temp'), '--user-directory', str(root/'user'), '--disable-auto-launch'], cwd=comfy, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic()+180
            while True:
                if proc.poll() is not None: raise RuntimeError('Owned ComfyUI exited; inspect comfy.log')
                try: api(port, '/system_stats'); break
                except (OSError, TimeoutError):
                    if time.monotonic() >= deadline: raise TimeoutError('ComfyUI startup timed out')
                    time.sleep(1)
            result = api(port, '/prompt', {'client_id': str(uuid.uuid4()), 'prompt': flow})
            if not result.get('prompt_id'): raise RuntimeError(f'Workflow rejected: {result}')
            prompt = result['prompt_id']; deadline = time.monotonic()+3600
            while time.monotonic() < deadline:
                if proc.poll() is not None: raise RuntimeError('Owned ComfyUI exited during generation')
                entry = api(port, '/history/'+prompt).get(prompt)
                if entry:
                    status = entry.get('status', {})
                    if status.get('status_str') == 'error': raise RuntimeError(f'Workflow failed: {status}')
                    if status.get('completed'):
                        files = list((root/'output').rglob('*.glb'))
                        if len(files) != 1: raise RuntimeError('Expected exactly one generated GLB')
                        output = contained(root/'output', files[0])
                        with output.open('rb') as model: header = model.read(4)
                        if output.stat().st_size < 20 or output.stat().st_size > 250_000_000 or header != b'glTF': raise RuntimeError('Invalid or oversized GLB output')
                        return {'output': str(output), 'promptId': prompt, 'seed': req['seed'], 'steps': req['steps'], 'resolution': req['resolution']}
                time.sleep(2)
            raise TimeoutError('Hunyuan3D generation exceeded one hour')
    finally:
        # Restore handlers first so repeated cancellation cannot interrupt cleanup.
        for sig, handler in previous.items(): signal.signal(sig, signal.SIG_IGN)
        stop_owned(proc)
        for sig, handler in previous.items(): signal.signal(sig, handler)


if __name__ == '__main__':
    print(json.dumps(run(json.loads(pathlib.Path(sys.argv[1]).read_text()))), flush=True)

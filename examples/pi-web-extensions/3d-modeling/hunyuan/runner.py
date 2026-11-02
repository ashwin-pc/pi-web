"""Owned, loopback-only ComfyUI Hunyuan3D runner; no downloads or Blender."""
import importlib.util
import json, os, pathlib, subprocess, sys

# Share the image runner's conservative process identification, including
# relative main.py launches from a ComfyUI checkout with an arbitrary name.
_image_spec = importlib.util.spec_from_file_location(
    'hunyuan_image_runner', pathlib.Path(__file__).resolve().parents[2] / 'image' / 'runner.py')
_image_runner = importlib.util.module_from_spec(_image_spec)
_image_spec.loader.exec_module(_image_runner)
active_comfy_processes = _image_runner.active_comfy_processes
process_cwd = _image_runner.process_cwd
process_executable = _image_runner.process_executable


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


def contained(root, value):
    path = pathlib.Path(value).resolve(strict=True)
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Output escapes owned directory or is not a file')
    return path


def run(req):
    root = pathlib.Path(req['root']).resolve(strict=True)
    configured = os.environ.get('PI_HUNYUAN_COMFY_ROOT', '').strip()
    if not configured: raise RuntimeError('Set PI_HUNYUAN_COMFY_ROOT to your ComfyUI checkout')
    comfy = pathlib.Path(configured).expanduser().resolve()
    python = pathlib.Path(os.environ.get('PI_HUNYUAN_PYTHON') or comfy / '.venv/bin/python')
    for required in [python, comfy/'main.py', comfy/'models/checkpoints/hunyuan_3d_v2.1.safetensors']:
        if not required.is_file(): raise RuntimeError(f'Missing installed dependency: {required}')
    from PIL import Image
    image_path = contained(root/'input', root/'input'/req['image'])
    with Image.open(image_path) as image:
        if image.width * image.height > 16_000_000: raise ValueError('Image exceeds 16 megapixels')
        image.verify()
    # Match installed image-tool preflight; never interrupt unrelated inference.
    if sys.platform != 'darwin':
        raise RuntimeError('This runtime requires macOS memory_pressure; no safe preflight is available on this platform')
    commands = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True, timeout=15)
    if active_comfy_processes(commands, process_cwd, process_executable):
        raise RuntimeError('Another ComfyUI process is active; retry when idle (nothing was stopped)')
    pressure = subprocess.check_output(['memory_pressure'], text=True, timeout=15)
    import re
    match = re.search(r'System-wide memory free percentage:\s*(\d+)', pressure)
    if not match or int(match.group(1)) < 25: raise RuntimeError('Memory preflight requires at least 25% free memory')
    for directory in ['output', 'temp', 'user']: (root/directory).mkdir(exist_ok=True)
    flow = workflow(req['image'], req['seed'], req['steps'], req['resolution'])
    (root/'workflow.json').write_text(json.dumps(flow, indent=2)+'\n')
    result = _image_runner.run_owned_comfy(python, comfy, root, flow,
        ['--temp-directory', str(root/'temp'), '--disable-auto-launch'])
    files = list((root/'output').rglob('*.glb'))
    if len(files) != 1: raise RuntimeError('Expected exactly one generated GLB')
    output = contained(root/'output', files[0])
    with output.open('rb') as model: header = model.read(4)
    if output.stat().st_size < 20 or output.stat().st_size > 250_000_000 or header != b'glTF': raise RuntimeError('Invalid or oversized GLB output')
    return {'output': str(output), 'promptId': result['prompt_id'], 'seed': req['seed'], 'steps': req['steps'], 'resolution': req['resolution']}


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.loads(pathlib.Path(sys.argv[1]).read_text()))), flush=True)
    except (Exception, KeyboardInterrupt) as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)

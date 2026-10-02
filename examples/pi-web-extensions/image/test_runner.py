"""Workflow and padding regression tests; run with unittest discover."""
import importlib.util
import json
import math
import pathlib
import sys
import types
import unittest
from unittest.mock import Mock, patch
import subprocess
import signal

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('image_runner', HERE / 'runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class WorkflowTests(unittest.TestCase):
    def test_process_group_cleanup_after_leader_exit_and_timeout(self):
        exited = Mock(pid=1234)
        with patch.object(runner.os, 'killpg', side_effect=ProcessLookupError):
            runner.stop_process_group(exited)
        exited.wait.assert_called_once_with(timeout=15)
        hanging = Mock(pid=5678)
        hanging.wait.side_effect = [subprocess.TimeoutExpired('ComfyUI', 15), 0]
        with patch.object(runner.os, 'killpg', side_effect=[None, ProcessLookupError]) as kill:
            runner.stop_process_group(hanging)
        self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(hanging.wait.call_count, 2)

    def test_local_qwen_variants_and_inputs(self):
        models = json.loads((HERE / 'config.example.json').read_text())['models']
        for name, profile in models.items():
            for inputs in ([], ['a.png'], ['a.png', 'b.png', 'c.png']):
                req = dict(profile=profile, prompt='test', seed=123, width=832, height=1280, edit_resolution=1024)
                graph = runner.workflow(req, inputs)
                self.assertEqual(graph['model']['class_type'], profile['model']['loader'])
                self.assertEqual(graph['model']['inputs']['unet_name'], profile['model']['file'])
                self.assertEqual(graph['vae']['class_type'], 'PiQwen21VAELoader')
                self.assertEqual(graph['encode']['inputs']['resolution'], 1024)
                self.assertEqual(sum(k.startswith('input_') for k in graph), len(inputs))
                fast = profile['sampling']['kind'] == 'viggle-flow'
                self.assertEqual(graph['sample']['class_type'], 'SamplerCustomAdvanced' if fast else 'KSampler')
                self.assertEqual('lora' in graph, 'lora' in profile)
                if fast:
                    self.assertEqual(graph['sigmas']['inputs'], {'width': 832, 'height': 1280})
                    self.assertEqual(graph['guider']['inputs']['cfg'], profile['sampling']['cfg'])
                else:
                    self.assertEqual(graph['sample']['inputs']['steps'], profile['sampling']['steps'])
        synthetic = dict(models['my-fast-qwen'], model=dict(loader='UnetLoaderGGUF',file='personal-qwen.gguf'))
        fast_graph = runner.workflow(dict(profile=synthetic,prompt='test',seed=1,width=512,height=512), [])
        self.assertEqual(fast_graph['model']['class_type'], 'UnetLoaderGGUF')
        self.assertEqual(fast_graph['sample']['class_type'], 'SamplerCustomAdvanced')
        self.assertEqual(fast_graph['lora']['inputs']['lora_name'], synthetic['lora']['file'])
        custom = dict(models['my-detailed-qwen'], model=dict(loader='UNETLoader',file='personal.safetensors'), sampling=dict(kind='standard',steps=27,cfg=2,sampler='heun',scheduler='normal',denoise=.8))
        graph = runner.workflow(dict(profile=custom,prompt='test',seed=1,width=512,height=512), [])
        self.assertEqual(graph['sample']['inputs']['steps'],27)
        self.assertEqual(graph['sample']['inputs']['sampler_name'],'heun')
        self.assertEqual(graph['sample']['inputs']['scheduler'],'normal')
        self.assertEqual(graph['model']['inputs']['unet_name'],'personal.safetensors')
        with self.assertRaises(ValueError): runner.profile_assets(dict(custom, model=dict(loader='UNETLoader',file='../outside')))

    def test_edit_resize_matches_encoder_and_sampler_for_both_schedules(self):
        models = json.loads((HERE / 'config.example.json').read_text())['models']
        cases = [(5000, 1000), (1000, 5000), (8000, 1000), (1000, 8000), (4000, 1000), (1000, 4000)]
        for original_w, original_h in cases:
            resolution, width, height = runner.edit_size(original_w, original_h, 1024)
            self.assertEqual(resolution % 32, 0)
            self.assertTrue(256 <= width <= 2048 and 256 <= height <= 2048)
            # Upstream TextEncodeQwenImage21 computes precisely this pair from resolution.
            ratio = original_w / original_h
            self.assertEqual(width, max(32, round(math.sqrt(resolution * resolution * ratio) / 32) * 32))
            self.assertEqual(height, max(32, round(math.sqrt(resolution * resolution / ratio) / 32) * 32))
            for profile in models.values():
                graph = runner.workflow(dict(profile=profile,prompt='edit',seed=1,width=width,height=height,edit_resolution=resolution), ['input.png'])
                self.assertEqual(graph['encode']['inputs']['resolution'], resolution)
                if profile['sampling']['kind'] == 'viggle-flow':
                    self.assertEqual(graph['sigmas']['inputs'], {'width':width,'height':height})
                else:
                    self.assertEqual(graph['sample']['inputs']['latent_image'], ['encode',2])
        self.assertEqual(runner.edit_size(5000,1000,1024), (896,2016,416))
        self.assertEqual(runner.edit_size(1000,5000,1024), (896,416,2016))
        for dimensions in [(10000,100), (100,10000)]:
            with self.assertRaisesRegex(ValueError, 'crop or pad'):
                runner.edit_size(*dimensions, 1024)

    def test_custom_node_math_and_padding_parity(self):
        try:
            import torch
        except ImportError:
            self.skipTest('torch not installed; run in isolated runtime for padding parity')
        comfy = types.ModuleType('comfy'); comfy.__path__ = []
        management = types.ModuleType('comfy.model_management'); comfy.model_management = management
        ldm = types.ModuleType('comfy.ldm'); ldm.__path__ = []
        wan = types.ModuleType('comfy.ldm.wan'); wan.__path__ = []
        vae = types.ModuleType('comfy.ldm.wan.vae2_2'); vae.AvgDown3D = type('AvgDown3D', (), {})
        nodes = types.ModuleType('nodes'); nodes.VAELoader = type('VAELoader', (), {})
        mocks = {'comfy': comfy, 'comfy.model_management': management, 'comfy.ldm': ldm, 'comfy.ldm.wan': wan, 'comfy.ldm.wan.vae2_2': vae, 'nodes': nodes}
        previous = {name: sys.modules.get(name) for name in mocks}
        try:
            sys.modules.update(mocks)
            spec = importlib.util.spec_from_file_location('pi_qwen21', HERE / 'custom_nodes/pi_qwen21/__init__.py')
            node = importlib.util.module_from_spec(spec); spec.loader.exec_module(node)
            for width, height in ((256, 256), (832, 1280), (1024, 1024), (2048, 2048)):
                seq = (width // 16) * (height // 16) // 4
                mu = .5 + .4 * (seq - 256) / (8192 - 256)
                expected = [math.exp(mu) / (math.exp(mu) + (1/t - 1)) for t in (1, .75, .5, .25)] + [0]
                torch.testing.assert_close(node.ViggleFlowSigmas().make(width, height)[0], torch.tensor(expected, dtype=torch.float32), atol=1e-7, rtol=1e-7)
            class MpsLike:
                device = types.SimpleNamespace(type='mps')
                def __init__(self, tensor): self.tensor = tensor; self.shape = tensor.shape
                def new_zeros(self, *shape): return torch.zeros(shape, dtype=self.tensor.dtype)
                def reshape(self, *shape): return self.tensor.reshape(*shape)
            original_cat = torch.cat
            try:
                torch.cat = lambda tensors, dim=0: original_cat([v.tensor if isinstance(v, MpsLike) else v for v in tensors], dim=dim)
                for t in (1, 2, 3, 4):
                    x = torch.randn(1, 8, t, 8, 8)
                    module = types.SimpleNamespace(factor_t=2, factor_s=2, out_channels=8, group_size=8)
                    actual = node.mps_safe_avg_down(module, MpsLike(x))
                    padded = torch.nn.functional.pad(x, (0, 0, 0, 0, (2-t%2)%2, 0))
                    expected = padded.reshape(1, 8, padded.shape[2]//2, 2, 4, 2, 4, 2).permute(0,1,3,5,7,2,4,6).contiguous().reshape(1,8,8,padded.shape[2]//2,4,4).mean(dim=2)
                    torch.testing.assert_close(actual, expected)
            finally: torch.cat = original_cat
        finally:
            for name, value in previous.items():
                if value is None: sys.modules.pop(name, None)
                else: sys.modules[name] = value

if __name__ == '__main__': unittest.main()

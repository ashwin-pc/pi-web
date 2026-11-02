import importlib.util
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('hunyuan_runner', pathlib.Path(__file__).with_name('runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def test_native_graph(self):
        flow = runner.workflow('source.png', 42, 30, 256)
        self.assertEqual(flow['checkpoint']['inputs']['ckpt_name'], 'hunyuan_3d_v2.1.safetensors')
        self.assertEqual(flow['sample']['inputs']['seed'], 42)
        self.assertEqual(flow['save']['class_type'], 'SaveGLB')
        self.assertEqual(flow['decode']['inputs']['octree_resolution'], 256)
        self.assertEqual(len(flow), 10)

    def test_only_owned_process_cleanup(self):
        owned = Mock(); owned.poll.return_value = None
        runner.stop_owned(owned)
        owned.terminate.assert_called_once()
        owned.wait.assert_called_once_with(timeout=10)
        owned.kill.assert_not_called()
        exited = Mock(); exited.poll.return_value = 0
        runner.stop_owned(exited)
        exited.terminate.assert_not_called()
        runner.stop_owned(None)

    def test_cleanup_escalates_and_reaps(self):
        owned = Mock(); owned.poll.return_value = None
        owned.wait.side_effect = [subprocess.TimeoutExpired('owned', 10), 0]
        runner.stop_owned(owned)
        owned.kill.assert_called_once()
        self.assertEqual(owned.wait.call_count, 2)

    def test_path_containment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); out = root/'output'; out.mkdir()
            outside = root/'secret.glb'; outside.write_bytes(b'private')
            (out/'escape.glb').symlink_to(outside)
            with self.assertRaises(ValueError): runner.contained(out, out/'escape.glb')
            good = out/'model.glb'; good.write_bytes(b'glTF')
            self.assertEqual(runner.contained(out, good), good.resolve())

    def test_active_process_is_never_stopped_or_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); comfy = root/'comfy'
            for name in ['.venv/bin/python', 'main.py', 'models/checkpoints/hunyuan_3d_v2.1.safetensors']:
                path = comfy/name; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
            (root/'input').mkdir(); (root/'input/source.png').touch()
            image = Mock(); image.width = image.height = 100
            opened = Mock(); opened.__enter__ = Mock(return_value=image); opened.__exit__ = Mock(return_value=False)
            pillow = Mock(); pillow.Image.open.return_value = opened
            with patch.dict('sys.modules', {'PIL': pillow}), patch.dict('os.environ', {'PI_HUNYUAN_COMFY_ROOT': str(comfy)}), patch.object(runner.subprocess, 'check_output', return_value='python /ComfyUI/main.py --listen 127.0.0.1'), patch.object(runner.subprocess, 'Popen') as start, patch.object(runner, 'stop_owned') as stop:
                with self.assertRaisesRegex(RuntimeError, 'Another ComfyUI'):
                    runner.run({'root': str(root), 'image': 'source.png', 'seed': 1, 'steps': 30, 'resolution': 256})
                start.assert_not_called(); stop.assert_not_called()

    def test_failure_cleans_owned_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); comfy = root/'comfy'
            for name in ['.venv/bin/python', 'main.py', 'models/checkpoints/hunyuan_3d_v2.1.safetensors']:
                path = comfy/name; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
            (root/'input').mkdir()
            (root/'input/source.png').write_bytes(b'image')
            image = Mock(); image.width = 100; image.height = 100
            opened = Mock(); opened.__enter__ = Mock(return_value=image); opened.__exit__ = Mock(return_value=False)
            pillow = Mock(); pillow.Image.open.return_value = opened
            child = Mock(); child.poll.return_value = None
            with patch.dict('sys.modules', {'PIL': pillow}), patch.dict('os.environ', {'PI_HUNYUAN_COMFY_ROOT': str(comfy)}), patch.object(runner.subprocess, 'check_output', side_effect=['', 'System-wide memory free percentage: 90%']), patch.object(runner.subprocess, 'Popen', return_value=child) as start, patch.object(runner, 'api', side_effect=[{}, {'error': 'bad graph'}]):
                with self.assertRaisesRegex(RuntimeError, 'Workflow rejected'):
                    runner.run({'root': str(root), 'image': 'source.png', 'seed': 1, 'steps': 30, 'resolution': 256})
                args = start.call_args.args[0]
                self.assertEqual(args[args.index('--listen')+1], '127.0.0.1')
                child.terminate.assert_called_once()
                child.wait.assert_called_once_with(timeout=10)


if __name__ == '__main__': unittest.main()

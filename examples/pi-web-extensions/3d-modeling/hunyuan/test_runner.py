import importlib.util
import pathlib
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('hunyuan_runner', pathlib.Path(__file__).with_name('runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
lifecycle = runner._image_runner


class RunnerTests(unittest.TestCase):
    def test_native_graph(self):
        flow = runner.workflow('source.png', 42, 30, 256)
        self.assertEqual(flow['checkpoint']['inputs']['ckpt_name'], 'hunyuan_3d_v2.1.safetensors')
        self.assertEqual(flow['sample']['inputs']['seed'], 42)
        self.assertEqual(flow['save']['class_type'], 'SaveGLB')
        self.assertEqual(flow['decode']['inputs']['octree_resolution'], 256)
        self.assertEqual(len(flow), 10)

    def test_path_containment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); out = root/'output'; out.mkdir()
            outside = root/'secret.glb'; outside.write_bytes(b'private')
            (out/'escape.glb').symlink_to(outside)
            with self.assertRaises(ValueError): runner.contained(out, out/'escape.glb')
            good = out/'model.glb'; good.write_bytes(b'glTF')
            self.assertEqual(runner.contained(out, good), good.resolve())

    def test_unconfigured_backend_fails_before_launch(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ', {}, clear=True), patch.object(lifecycle, 'run_owned_comfy') as launch:
            with self.assertRaisesRegex(RuntimeError, 'Set PI_HUNYUAN_COMFY_ROOT'):
                runner.run({'root': tmp})
            launch.assert_not_called()

    def test_process_group_cleanup_includes_exited_leader(self):
        child = Mock(pid=123)
        with patch.object(lifecycle.os, 'killpg') as kill, patch.object(lifecycle, 'process_group_exists', return_value=False):
            lifecycle.stop_process_group(child)
        kill.assert_called_once_with(123, signal.SIGTERM)
        child.wait.assert_called_once_with(timeout=0)

    def test_process_group_cleanup_escalates(self):
        child = Mock(pid=123)
        with patch.object(lifecycle.os, 'killpg') as kill, patch.object(lifecycle.time, 'monotonic', side_effect=[0, 16]):
            lifecycle.stop_process_group(child)
        self.assertEqual(kill.call_args_list[0].args, (123, signal.SIGTERM))
        self.assertEqual(kill.call_args_list[1].args, (123, signal.SIGKILL))
        child.wait.assert_called_once_with(timeout=5)

    def test_shared_lifecycle_success_and_failure_cleanup(self):
        for responses, error in [([{}, {'prompt_id': 'p'}, {'p': {'status': {'completed': True}, 'outputs': {}}}], None), ([{}, {'error': 'bad graph'}], 'Workflow rejected'), ([{}, {'prompt_id': 'p'}, {'p': {'status': {'status_str': 'error'}}}], 'Inference failed')]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); child = Mock(); child.poll.return_value = None
                with patch.object(lifecycle.subprocess, 'Popen', return_value=child) as start, patch.object(lifecycle, 'api', side_effect=responses), patch.object(lifecycle, 'stop_process_group') as stop:
                    if error:
                        with self.assertRaisesRegex(RuntimeError, error): lifecycle.run_owned_comfy('/python', root, root, {})
                    else:
                        self.assertEqual(lifecycle.run_owned_comfy('/python', root, root, {})['prompt_id'], 'p')
                    self.assertTrue(start.call_args.kwargs['start_new_session'])
                    argv = start.call_args.args[0]
                    self.assertEqual(argv[argv.index('--listen')+1], '127.0.0.1')
                    stop.assert_called_once_with(child)

    def test_startup_and_inference_timeouts_cleanup(self):
        cases = [([0, 181], [], 'startup timed out'),
                 ([0, 0, 1, 3602], [{}, {'prompt_id': 'p'}], 'Inference timed out')]
        for clock, responses, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); child = Mock(); child.poll.return_value = None
                with patch.object(lifecycle.subprocess, 'Popen', return_value=child), patch.object(lifecycle, 'api', side_effect=responses), patch.object(lifecycle.time, 'monotonic', side_effect=clock), patch.object(lifecycle, 'stop_process_group') as stop:
                    with self.assertRaisesRegex(TimeoutError, message):
                        lifecycle.run_owned_comfy('/python', root, root, {})
                    stop.assert_called_once_with(child)

    def test_spawn_failure_restores_handlers_without_stopping_unowned_process(self):
        previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
        with tempfile.TemporaryDirectory() as tmp, patch.object(lifecycle.subprocess, 'Popen', side_effect=OSError('spawn failed')), patch.object(lifecycle, 'stop_process_group') as stop:
            with self.assertRaisesRegex(OSError, 'spawn failed'):
                lifecycle.run_owned_comfy('/python', pathlib.Path(tmp), pathlib.Path(tmp), {})
            stop.assert_not_called()
        for s, handler in previous.items(): self.assertEqual(signal.getsignal(s), handler)

    def test_real_urllib_connect_cancellation_is_not_wrapped_or_retried(self):
        # Keep the actual api -> urlopen -> HTTPHandler.do_open wrapping path;
        # only replace the lowest HTTP connect/send call, without any network.
        import http.client
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp); child = Mock(); child.poll.return_value = None
                previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
                def cancel(*args, **kwargs): signal.getsignal(sig)(sig, None)
                with patch.object(lifecycle.subprocess, 'Popen', return_value=child), patch.object(http.client.HTTPConnection, 'request', side_effect=cancel) as request, patch.object(lifecycle, 'stop_process_group') as stop, patch.object(lifecycle.time, 'sleep') as sleep:
                    with self.assertRaisesRegex(KeyboardInterrupt, 'ComfyUI cancelled'):
                        lifecycle.run_owned_comfy('/python', root, root, {})
                    request.assert_called_once()
                    sleep.assert_not_called()
                    stop.assert_called_once_with(child)
                for s, handler in previous.items(): self.assertEqual(signal.getsignal(s), handler)

    def test_hunyuan_preflight_and_shared_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); comfy = root/'checkout'
            for name in ['.venv/bin/python', 'main.py', 'models/checkpoints/hunyuan_3d_v2.1.safetensors']:
                path = comfy/name; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
            (comfy/'comfy').mkdir()
            (root/'input').mkdir(); (root/'input/source.png').touch()
            image = Mock(); image.width = image.height = 100
            opened = Mock(); opened.__enter__ = Mock(return_value=image); opened.__exit__ = Mock(return_value=False)
            pillow = Mock(); pillow.Image.open.return_value = opened
            req = {'root': str(root), 'image': 'source.png', 'seed': 1, 'steps': 30, 'resolution': 256}
            with patch.dict('sys.modules', {'PIL': pillow}), patch.dict('os.environ', {'PI_HUNYUAN_COMFY_ROOT': str(comfy), 'PI_HUNYUAN_PYTHON': str(comfy/'.venv/bin/python')}), patch.object(runner.sys, 'platform', 'darwin'), patch.object(runner, 'process_cwd', return_value=comfy), patch.object(runner, 'process_executable', return_value='/usr/bin/python3'), patch.object(lifecycle, 'run_owned_comfy') as launch:
                with patch.object(runner.subprocess, 'check_output', return_value='123 python main.py'):
                    with self.assertRaisesRegex(RuntimeError, 'Another ComfyUI'): runner.run(req)
                    launch.assert_not_called()
                with patch.object(runner.sys, 'platform', 'linux'), patch.object(runner.subprocess, 'check_output') as check:
                    with self.assertRaisesRegex(RuntimeError, 'requires macOS'): runner.run(req)
                    check.assert_not_called()
                def generate(*args):
                    (root/'output/model.glb').write_bytes(b'glTF'+b'0'*20)
                    return {'prompt_id': 'p'}
                launch.side_effect = generate
                with patch.object(runner.subprocess, 'check_output', side_effect=['', 'System-wide memory free percentage: 90%']):
                    self.assertEqual(runner.run(req)['promptId'], 'p')
                    self.assertEqual(launch.call_args.args[0], comfy/'.venv/bin/python')


if __name__ == '__main__': unittest.main()

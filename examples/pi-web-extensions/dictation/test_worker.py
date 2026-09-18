from array import array
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

import worker
from adapters.parakeet.mlx import adapter as parakeet_adapter
from adapters.whisper.mlx import adapter as whisper_adapter
from adapters.whisper.faster_whisper import adapter as faster_whisper_adapter


def write_wav(path: Path, seconds: float, sample: int = 1000):
    samples = array("h", [sample] * int(16000 * seconds))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(samples.tobytes())


class WorkerTests(unittest.TestCase):
    def test_validate_rejects_relative_and_symlink_paths(self):
        with self.assertRaisesRegex(ValueError, "absolute"):
            worker.validate_input("relative.webm")
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "audio"
            original.write_bytes(b"audio")
            link = Path(directory) / "link"
            try:
                link.symlink_to(original)
            except OSError:
                # Windows can require Developer Mode or symlink privileges. The
                # remaining suite still exercises Windows path/ACL behavior.
                return
            with self.assertRaisesRegex(ValueError, "non-symlink"):
                worker.validate_input(str(link))

    def test_work_dir_must_be_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "work"
            path.mkdir(mode=0o755)
            path.chmod(0o755)
            if os.name == "posix":
                with self.assertRaisesRegex(ValueError, "group or other"):
                    worker.validate_work_dir(str(path))
                path.chmod(0o700)
            self.assertEqual(worker.validate_work_dir(str(path)), path)

    def test_mime_type_selects_only_expected_demuxers(self):
        self.assertEqual(worker.input_format("audio/webm;codecs=opus"), "matroska")
        self.assertEqual(worker.input_format("audio/mp4"), "mov")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            worker.input_format("application/x-mpegurl")

    def test_decode_forces_protocol_demuxer_and_bounds_output(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "decoded.wav"
            write_wav(destination, 1)
            with patch("worker.shutil.which", return_value="/usr/bin/ffmpeg"), patch("worker.subprocess.run") as run:
                duration = worker.decode_audio(Path("/tmp/input"), destination, "matroska")
            command = run.call_args.args[0]
            self.assertEqual(duration, 1)
            self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file,pipe")
            self.assertEqual(command[command.index("-f") + 1], "matroska")
            self.assertEqual(command[command.index("-t") + 1], "121")

    def test_decoded_duration_over_120_seconds_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "decoded.wav"
            write_wav(destination, 120.01)
            with patch("worker.shutil.which", return_value="/usr/bin/ffmpeg"), patch("worker.subprocess.run"):
                with self.assertRaisesRegex(ValueError, "120 seconds"):
                    worker.decode_audio(Path("/tmp/input"), destination, "wav")

    def test_silence_is_rejected_before_model_load(self):
        with tempfile.TemporaryDirectory() as directory:
            silent = Path(directory) / "silent.wav"
            write_wav(silent, 0.25, sample=0)
            with patch.object(worker, "get_adapter") as get_adapter:
                with self.assertRaisesRegex(RuntimeError, "silent or too quiet"):
                    worker.ensure_audible(silent)
                get_adapter.assert_not_called()

    def test_transcribe_uses_host_owned_work_directory_and_selected_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "capture.webm"
            source.write_bytes(b"fake")
            work_dir = Path(directory) / "work"
            work_dir.mkdir(mode=0o700)
            adapter = Mock()
            adapter.transcribe.return_value = "  Test transcript.  "
            with patch.object(worker, "decode_audio", return_value=1.0) as decode, patch.object(worker, "ensure_audible"), patch.object(worker, "preflight"), patch.object(worker, "get_adapter", return_value=adapter) as get_adapter:
                result = worker.transcribe(source, work_dir, "matroska", "parakeet", "mlx", "local/model", "cpu", "int8")
            self.assertEqual(result["text"], "Test transcript.")
            self.assertEqual(result["model"], "local/model")
            self.assertEqual(result["family"], "parakeet")
            self.assertEqual(result["runtime"], "mlx")
            get_adapter.assert_called_once_with("parakeet", "mlx")
            adapter.transcribe.assert_called_once()
            decode.assert_called_once_with(source, work_dir / "capture.wav", "matroska")

    def test_unknown_backend_is_rejected_without_loading_provider_code(self):
        with self.assertRaisesRegex(ValueError, "unsupported dictation family/runtime"):
            worker.get_adapter("not-installed", "unknown")

    def test_request_propagates_backend_and_model(self):
        with patch.object(worker, "transcribe", return_value={"text": "ok"}) as transcribe:
            with tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "audio.wav"
                source.write_bytes(b"audio")
                work = Path(directory) / "work"
                work.mkdir(mode=0o700)
                result = worker.handle({"id": "1", "op": "transcribe", "path": str(source), "workDir": str(work), "mimeType": "audio/wav", "family": "whisper", "runtime": "faster-whisper", "model": "org/model", "device": "cpu", "computeType": "int8"})
        self.assertTrue(result["ok"])
        self.assertEqual(transcribe.call_args.args[-5:], ("whisper", "faster-whisper", "org/model", "cpu", "int8"))

    def test_ping_lists_capabilities_without_loading_adapters(self):
        with patch.object(worker, "capabilities", return_value=[{"family": "whisper", "runtime": "faster-whisper"}]):
            self.assertEqual(worker.handle({"id": "1", "op": "ping"})["capabilities"][0]["runtime"], "faster-whisper")

    def test_parakeet_adapter_loads_requested_model_lazily(self):
        provider = Mock()
        model = Mock()
        model.transcribe.return_value = Mock(text="parakeet text")
        provider.from_pretrained.return_value = model
        with patch.dict(sys.modules, {"parakeet_mlx": provider}), patch.object(parakeet_adapter, "_models", {}):
            text = parakeet_adapter.transcribe(Path("audio.wav"), "org/custom-parakeet", Mock())
        self.assertEqual(text, "parakeet text")
        provider.from_pretrained.assert_called_once_with("org/custom-parakeet")

    def test_whisper_adapter_passes_requested_model(self):
        provider = Mock()
        provider.transcribe.return_value = {"text": "whisper text"}
        with patch.dict(sys.modules, {"mlx_whisper": provider}):
            text = whisper_adapter.transcribe(Path("audio.wav"), "org/custom-whisper", Mock())
        self.assertEqual(text, "whisper text")
        provider.transcribe.assert_called_once_with("audio.wav", path_or_hf_repo="org/custom-whisper")

    def test_faster_whisper_consumes_segments_and_passes_cpu_configuration(self):
        provider = Mock()
        model = Mock()
        model.transcribe.return_value = (iter([Mock(text="portable "), Mock(text="whisper")]), Mock())
        provider.WhisperModel.return_value = model
        with patch.dict(sys.modules, {"faster_whisper": provider}), patch.object(faster_whisper_adapter, "_models", {}):
            text = faster_whisper_adapter.transcribe(Path("audio.wav"), "large-v3-turbo", Mock(), device="cpu", compute_type="int8")
        self.assertEqual(text, "portable whisper")
        provider.WhisperModel.assert_called_once_with("large-v3-turbo", device="cpu", compute_type="int8")
        model.transcribe.assert_called_once_with("audio.wav", beam_size=5)

    def test_preflight_happens_before_audio_decode(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / "work"
            work.mkdir(mode=0o700)
            with patch.object(worker, "preflight", side_effect=RuntimeError("runtime missing")), patch.object(worker, "decode_audio") as decode:
                with self.assertRaisesRegex(RuntimeError, "runtime missing"):
                    worker.transcribe(Path(directory) / "input", work, "wav", "whisper", "faster-whisper", "tiny", "cpu", "int8")
            decode.assert_not_called()

    def test_windows_reparse_attribute_is_rejected_on_python_310_compatible_api(self):
        info = Mock(st_file_attributes=0x400, st_reparse_tag=0)
        self.assertTrue(worker.is_windows_reparse_point(info))

    @unittest.skipUnless(sys.platform == "win32", "requires a real Windows junction")
    def test_windows_work_directory_rejects_real_junction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            junction = root / "junction"
            target.mkdir()
            created = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)],
                capture_output=True,
                text=True,
                shell=False,
            )
            if created.returncode != 0:
                self.skipTest(f"could not create junction: {created.stderr or created.stdout}")
            with self.assertRaisesRegex(ValueError, "junction or reparse point"):
                worker.validate_work_dir(str(junction))

    def test_windows_work_directory_uses_acl_without_posix_mode_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "work"
            path.mkdir()
            path.chmod(0o777)
            info = path.stat()
            worker.validate_private_directory(info, "nt")
            with self.assertRaisesRegex(ValueError, "group or other"):
                worker.validate_private_directory(info, "posix")

    def test_stdio_worker_exits_cleanly_on_parent_eof(self):
        process = subprocess.Popen(
            [sys.executable, "-u", worker.__file__],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = process.communicate('{"id":"eof","op":"ping"}\n', timeout=5)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)["id"], "eof")


if __name__ == "__main__":
    unittest.main()

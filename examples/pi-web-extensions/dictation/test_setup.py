from pathlib import Path
import importlib.util
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("dictation_setup", Path(__file__).with_name("setup.py"))
assert SPEC and SPEC.loader
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_venv_interpreter_path_is_platform_specific(self):
        with patch.object(setup.sys, "platform", "win32"):
            self.assertEqual(setup.venv_python(Path("root")), Path("root/.venv/Scripts/python.exe"))
        with patch.object(setup.sys, "platform", "linux"):
            self.assertEqual(setup.venv_python(Path("root")), Path("root/.venv/bin/python"))

    def test_commands_use_current_python_to_create_venv_and_no_shell(self):
        with patch.object(setup, "venv_python", return_value=Path("missing/python")):
            result = setup.commands("whisper-faster-whisper")
        self.assertEqual(result[0][:3], [sys.executable, "-m", "venv"])
        self.assertIn("adapters/whisper/faster_whisper/requirements.txt", result[-1][-1].replace("\\", "/"))

    def test_photon_target_installs_its_dependency_file(self):
        with patch.object(setup, "venv_python", return_value=Path("missing/python")):
            result = setup.commands("parakeet-photon")
        self.assertIn("adapters/parakeet/photon/requirements.txt", result[-1][-1].replace("\\", "/"))

    def test_photon_target_validates_platform_architecture_before_install(self):
        supported = [("darwin", "arm64"), ("darwin", "aarch64"), ("win32", "AMD64"), ("win32", "x86_64"), *[("linux", arch) for arch in ("x86_64", "amd64", "aarch64", "arm64")]]
        unsupported = [("darwin", "x86_64"), ("win32", "ARM64"), ("win32", "aarch64"), ("linux", "i686"), ("freebsd", "x86_64")]
        for system, machine in supported + unsupported:
            with self.subTest(system=system, machine=machine), patch.object(setup.sys, "platform", system), patch.object(setup.platform, "machine", return_value=machine):
                if (system, machine) in supported:
                    setup.validate_target("parakeet-photon")
                else:
                    with self.assertRaisesRegex(SystemExit, "Photon requires"):
                        setup.validate_target("parakeet-photon")

    def test_photon_installs_cpu_torch_before_runtime_on_linux_and_windows(self):
        for system in ("linux", "win32"):
            with self.subTest(system=system), patch.object(setup.sys, "platform", system), patch.object(setup, "venv_python", return_value=Path("missing/python")):
                result = setup.commands("parakeet-photon")
            self.assertEqual(result[-2], [str(Path("missing/python")), "-m", "pip", "install", "torch==2.14.1+cpu", "--index-url", "https://download.pytorch.org/whl/cpu"])
            self.assertEqual(result[-1][-2], "-r")

    def test_photon_uses_standard_torch_on_macos_and_other_targets_unchanged(self):
        with patch.object(setup.sys, "platform", "darwin"), patch.object(setup, "venv_python", return_value=Path("missing/python")):
            result = setup.commands("parakeet-photon")
            whisper = setup.commands("whisper-faster-whisper")
        self.assertEqual(result[-2][-1], "torch")
        self.assertNotIn("--index-url", result[-2])
        self.assertFalse(any("torch" in argument for command in whisper for argument in command))

    def test_mlx_fails_fast_off_apple_silicon(self):
        with patch.object(setup.sys, "platform", "win32"), patch.object(setup.platform, "machine", return_value="AMD64"):
            with self.assertRaisesRegex(SystemExit, "Apple Silicon"):
                setup.validate_target("parakeet-mlx")


if __name__ == "__main__":
    unittest.main()

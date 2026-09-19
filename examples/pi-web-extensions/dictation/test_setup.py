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

    def test_mlx_fails_fast_off_apple_silicon(self):
        with patch.object(setup.sys, "platform", "win32"), patch.object(setup.platform, "machine", return_value="AMD64"):
            with self.assertRaisesRegex(SystemExit, "Apple Silicon"):
                setup.validate_target("parakeet-mlx")


if __name__ == "__main__":
    unittest.main()

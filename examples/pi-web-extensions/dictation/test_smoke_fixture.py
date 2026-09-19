"""Lightweight integrity and FFmpeg decode checks for the committed smoke fixture."""

from pathlib import Path
import shutil
import tempfile
import unittest
import wave

from worker import decode_audio


FIXTURE = Path(__file__).parent / "test-data" / "smoke.wav"


class SmokeFixtureTests(unittest.TestCase):
    def test_pcm_fixture_metadata_and_samples(self) -> None:
        with wave.open(str(FIXTURE), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getframerate(), audio.getsampwidth()), (1, 16000, 2))
            self.assertEqual(audio.getnframes(), 52896)
            self.assertEqual(audio.getcomptype(), "NONE")
            self.assertTrue(any(audio.readframes(audio.getnframes())))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for the decode smoke test")
    def test_fixture_decodes_through_production_ffmpeg_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "decoded.wav"
            duration = decode_audio(FIXTURE, output, "wav")
            self.assertAlmostEqual(duration, 3.306, places=3)
            with wave.open(str(output), "rb") as decoded:
                self.assertEqual((decoded.getnchannels(), decoded.getframerate(), decoded.getsampwidth()), (1, 16000, 2))
                self.assertGreater(decoded.getnframes(), 0)


if __name__ == "__main__":
    unittest.main()

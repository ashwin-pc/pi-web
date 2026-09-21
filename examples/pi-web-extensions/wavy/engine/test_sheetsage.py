import importlib.util, json, subprocess, sys, tempfile, unittest, wave
from pathlib import Path

SCRIPT=Path(__file__).with_name("sheetsage.py")
spec=importlib.util.spec_from_file_location("wavy_sheetsage",SCRIPT); bridge=importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
class SheetSageBridgeTests(unittest.TestCase):
    def test_status_is_honest_and_noncommercial(self):
        p=subprocess.run([sys.executable,str(SCRIPT),'--status'],capture_output=True,text=True,check=True)
        value=json.loads(p.stdout)
        self.assertFalse(value['available'])
        self.assertIn('NC',value['license'])
    def test_media_preflight_accepts_bounded_wav_and_rejects_invalid_container(self):
        with tempfile.TemporaryDirectory() as d:
            wav=Path(d)/'ok.wav'
            with wave.open(str(wav),'wb') as f:
                f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000);f.writeframes(b'\0\0'*2400)
            info=bridge.preflight_audio(wav)
            self.assertEqual(info['channels'],1);self.assertEqual(info['sampleRate'],24000)
            bad=Path(d)/'bad.mp3';bad.write_bytes(b'not audio')
            with self.assertRaises(ValueError):bridge.preflight_audio(bad)
    def test_transcription_fails_actionably_and_retains_result(self):
        with tempfile.TemporaryDirectory() as d:
            result=Path(d)/'result.json'
            p=subprocess.run([sys.executable,str(SCRIPT),'--request',str(Path(d)/'request.json'),'--result',str(result)],capture_output=True,text=True)
            self.assertEqual(p.returncode,3)
            value=json.loads(result.read_text())
            self.assertEqual(value['error']['code'],'SHEETSAGE_FAILED')

if __name__ == '__main__': unittest.main()

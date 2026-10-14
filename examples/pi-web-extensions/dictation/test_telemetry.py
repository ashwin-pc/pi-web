"""Lightweight shim tests plus optional checks against the installed pinned wheels."""

import asyncio
from hashlib import sha256
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from adapters.parakeet.photon import telemetry


class TelemetryGuardTests(unittest.TestCase):
    def test_disabled_reporter_has_no_client_task_or_collection(self):
        reporter = telemetry._DisabledReporter(None, None, api_key="", api_base_url="https://api.moondream.ai")
        async def lifecycle():
            self.assertFalse(await reporter.validate_api_key())
            reporter.start()
            reporter.record_success(finetune=None, input_tokens=3, output_tokens=5)
            reporter.record_error(finetune=None)
            await reporter.shutdown()
        asyncio.run(lifecycle())
        self.assertEqual(vars(reporter), {})
        with self.assertRaisesRegex(RuntimeError, "empty API key"):
            telemetry._DisabledReporter(None, None, api_key="ambient-secret", api_base_url="")

    def test_source_version_identity_and_existing_engine_guards(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.py"
            source.write_bytes(b"audited source\n")
            audit = {"package": ("1.0", {"source.py": sha256(source.read_bytes()).hexdigest()})}
            installed = SimpleNamespace(version="1.0", locate_file=lambda name: Path(root) / name)
            original = object()
            core = SimpleNamespace(PhotonReporter=original)
            modules = {"kestrel.engine.core": core, "kestrel.photon": SimpleNamespace(PhotonReporter=original), "moondream.photon_vl": SimpleNamespace(_engine_cache={})}
            with patch.object(telemetry, "_AUDITED", audit), patch.object(telemetry, "distribution", return_value=installed), patch.object(telemetry, "import_module", side_effect=modules.__getitem__) as load:
                installed.version = "1.1"
                with self.assertRaisesRegex(RuntimeError, "refusing inference"):
                    telemetry.disable_telemetry()
                load.assert_not_called()
                installed.version = "1.0"
                source.write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "unaudited source"):
                    telemetry.disable_telemetry()
                load.assert_not_called()
                source.write_bytes(b"audited source\n")
                modules["moondream.photon_vl"]._engine_cache = {"already running": True}
                with self.assertRaisesRegex(RuntimeError, "already initialized"):
                    telemetry.disable_telemetry()
                modules["moondream.photon_vl"]._engine_cache = {}
                core.PhotonReporter = object()
                with self.assertRaisesRegex(RuntimeError, "already modified"):
                    telemetry.disable_telemetry()
                core.PhotonReporter = original
                telemetry.disable_telemetry()
                self.assertIs(core.PhotonReporter, telemetry._DisabledReporter)
                telemetry.disable_telemetry()  # idempotent for the warm worker
                source.write_bytes(b"changed after patch")
                with self.assertRaisesRegex(RuntimeError, "unaudited source"):
                    telemetry.disable_telemetry()


@unittest.skipUnless(find_spec("moondream") and find_spec("kestrel"), "optional real pinned packages not installed")
class InstalledPackageTelemetryTests(unittest.TestCase):
    def test_real_startup_periodic_shutdown_and_empty_key(self):
        import httpx
        import kestrel.photon as photon
        import kestrel.engine.core as core
        import moondream.photon_vl as vl

        cfg = Mock(model="moondream/parakeet-redux", service_name="dictation")
        device = SimpleNamespace(type="cpu", __str__=lambda: "cpu")
        cfg.resolved_device.return_value = device
        original = core.PhotonReporter
        client = MagicMock()
        client.post = AsyncMock(return_value=Mock(status_code=200, json=lambda: {"standing": "anonymous"}))
        client.aclose = AsyncMock()

        async def before():
            reporter = original(cfg, device, api_key="", api_base_url="https://api.moondream.ai")
            await reporter.validate_api_key()
            self.assertEqual(client.post.await_count, 1)  # startup
            reporter.start()
            await asyncio.sleep(0.02)  # accelerated real periodic loop
            self.assertGreater(client.post.await_count, 1)
            await reporter.shutdown()

        with patch.object(httpx, "AsyncClient", return_value=client), patch.object(photon, "_TELEMETRY_FLUSH_INTERVAL_SECONDS", 0.001):
            asyncio.run(before())
        before_count = client.post.await_count
        self.assertGreaterEqual(before_count, 3)
        self.assertIn("hostname", client.post.call_args.kwargs["json"]["reports"][0])

        class FakeEngine:
            def __init__(self, runtime_cfg, **kwargs):
                self.kwargs = kwargs
            async def _ensure_started(self):
                pass

        async def after():
            # Exercise real InferenceEngine.create with an ambient key. Only
            # native model initialization is replaced, not key/provider logic.
            engine = await core.InferenceEngine.create.__func__(FakeEngine, cfg, api_key="")
            self.assertIsNone(engine.kwargs["api_key"])
            self.assertIsNone(engine.kwargs["adapter_provider"])
            self.assertFalse(engine.kwargs["adapter_provider_uses_api_key"])
            state = SimpleNamespace(
                _initialized=False, _model_ids=[], _photon_reporter=None,
                _runtime_cfg=cfg, _api_key=None, _api_base_url="https://api.moondream.ai",
                _adapter_provider_uses_api_key=False,
                _scheduler_thread=Mock(is_alive=lambda: True),
                _worker_task=Mock(done=lambda: False),
                _warmup_query_pipeline=AsyncMock(),
            )
            # Real engine initialization constructs/validates/starts the shim.
            with patch.object(core.threading, "Thread"):
                await core.InferenceEngine._initialize(state)
            reporter = state._photon_reporter
            self.assertIsInstance(reporter, telemetry._DisabledReporter)
            reporter.record_success(finetune=None, input_tokens=1, output_tokens=2)
            reporter.record_error(finetune=None)
            await asyncio.sleep(0.02)
            await reporter.shutdown()
            self.assertEqual(vars(reporter), {})

        try:
            with patch.dict(os.environ, {"MOONDREAM_API_KEY": "ambient-secret"}), patch.object(httpx, "AsyncClient") as network, patch.object(photon.socket, "gethostname") as hostname:
                telemetry.disable_telemetry()  # real versions + actual source hashes
                asyncio.run(after())
                network.assert_not_called()
                hostname.assert_not_called()
            self.assertFalse(vl._engine_cache)  # no weights/native engine needed
        finally:
            core.PhotonReporter = original
        print(f"Real pinned source: upstream startup/periodic/shutdown POSTs={before_count}; shim HTTP clients=0; ambient key/cloud provider=None")


if __name__ == "__main__":
    unittest.main()

import { spawnSync } from "node:child_process";
import {
  authenticatedTunnelRequest,
  effectivePeerAddress,
  initializeSupervisorPeerContext,
} from "../../server/auth/supervisorPeer.js";

initializeSupervisorPeerContext(process.env);

const subprocess = spawnSync(process.execPath, [
  "tests/fixtures/supervisor-secret-presence.mjs",
], { encoding: "utf8" });
if (subprocess.error) throw subprocess.error;
if (subprocess.status !== 0) throw new Error("Environment probe subprocess failed");

const accepted = authenticatedTunnelRequest({
  headers: {
    "x-pi-web-peer": "192.0.2.44",
    "x-pi-web-tunnel": "1",
    "x-pi-web-supervisor-secret": "synthetic-secret",
  },
  socket: { remoteAddress: "::ffff:127.0.0.1" },
});
const peer = effectivePeerAddress({
  headers: {
    "x-pi-web-peer": "192.0.2.44",
    "x-pi-web-tunnel": "1",
    "x-pi-web-supervisor-secret": "synthetic-secret",
  },
  socket: { remoteAddress: "::ffff:127.0.0.1" },
});

process.stdout.write(JSON.stringify({
  inherited: subprocess.stdout,
  accepted,
  peer,
  secretCleared: !("PI_WEB_SUPERVISOR_SECRET" in process.env),
  socketCleared: !("PI_WEB_TUNNEL_SOCKET" in process.env),
}));

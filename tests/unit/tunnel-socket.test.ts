import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeTunnelSocket, listenOnTunnelSocket } from "../../server/tunnelSocket.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(async directory => {
    temporaryDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("tunnel socket startup validation", () => {
  it("rejects relative paths before listening", async () => {
    const server = createServer();
    await expect(listenOnTunnelSocket(server, "relative.sock"))
      .rejects.toThrow("PI_WEB_TUNNEL_SOCKET must be an absolute path");
    expect(server.listening).toBe(false);
  });

  it("rejects parents accessible by group or other users", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-tunnel-parent-"));
    temporaryDirectories.add(parent);
    await chmod(parent, 0o755);
    const server = createServer();
    await expect(listenOnTunnelSocket(server, join(parent, "pi-web.sock")))
      .rejects.toThrow("PI_WEB_TUNNEL_SOCKET parent must not be accessible by group or other users");
    expect(server.listening).toBe(false);
    await expect(lstat(join(parent, "pi-web.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its verified socket on close", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-tunnel-cleanup-"));
    temporaryDirectories.add(parent);
    await chmod(parent, 0o700);
    const path = join(parent, "pi-web.sock");
    const server = createServer();
    const identity = await listenOnTunnelSocket(server, path);
    await closeTunnelSocket(server, path, identity);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

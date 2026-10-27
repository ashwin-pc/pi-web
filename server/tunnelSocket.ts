import { lstat, unlink } from "node:fs/promises";
import type { Server } from "node:http";
import { isAbsolute, dirname } from "node:path";

type SocketIdentity = { dev: number; ino: number };

async function requirePrivateParent(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory()) throw new Error("PI_WEB_TUNNEL_SOCKET parent is not a directory");
  if (typeof process.getuid === "function" && parent.uid !== process.getuid())
    throw new Error("PI_WEB_TUNNEL_SOCKET parent must be owned by the running user");
  if ((parent.mode & 0o077) !== 0)
    throw new Error("PI_WEB_TUNNEL_SOCKET parent must not be accessible by group or other users");
}

export async function listenOnTunnelSocket(
  server: Server,
  path: string,
): Promise<SocketIdentity> {
  if (!isAbsolute(path)) throw new Error("PI_WEB_TUNNEL_SOCKET must be an absolute path");
  await requirePrivateParent(path);
  try {
    await lstat(path);
    throw new Error(`PI_WEB_TUNNEL_SOCKET already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    const previousUmask = process.umask(0o177);
    try {
      server.listen(path);
    } finally {
      process.umask(previousUmask);
    }
  });

  const socket = await lstat(path);
  if (
    !socket.isSocket() ||
    (socket.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && socket.uid !== process.getuid())
  ) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("PI_WEB_TUNNEL_SOCKET was not created as a user-owned mode 0600 socket");
  }
  return { dev: socket.dev, ino: socket.ino };
}

export async function closeTunnelSocket(
  server: Server,
  path: string,
  identity: SocketIdentity,
): Promise<void> {
  let ownsPath = false;
  try {
    const current = await lstat(path);
    ownsPath = current.isSocket() &&
      current.dev === identity.dev &&
      current.ino === identity.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Node unlinks a Unix socket path as part of server.close(). If the entry was
  // replaced, leave the handle for process exit rather than unlinking that entry.
  if (!ownsPath) {
    server.unref();
    return;
  }
  await new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  try {
    const current = await lstat(path);
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino)
      await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

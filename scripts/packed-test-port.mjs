import { createServer } from "node:net";

// Let the OS select a permitted loopback port. A fixed/random number can land
// in Windows' excluded TCP port ranges even when no process owns that port.
export async function availableLoopbackPort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

// Only a bind race or OS-reserved port merits a fresh probe. All other startup
// failures must retain their original stderr and fail the package smoke test.
export function isRetryableBindFailure(stderr) {
  return /listen (?:EADDRINUSE|EACCES):[^\n]*127\.0\.0\.1:\d+/.test(stderr);
}

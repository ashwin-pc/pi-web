import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { observeServer, reserveStlOrigin } from './e2e/helpers/owned-stl-server.js';

function launch(source: string) {
  const child = spawn(process.execPath, ['-e', source], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ...observeServer(child), child };
}

describe('owned STL server readiness', () => {
  it('waits for an authenticated delayed listener beyond the old five-second poll limit', async () => {
    const { port, origin } = await reserveStlOrigin();
    const server = launch(`setTimeout(() => require('http').createServer((req, res) => { res.writeHead(401); res.end(); }).listen(${port}, '127.0.0.1'), 5200)`);
    try { await server.ready(origin, 8000); } finally { await server.stop(); }
  }, 12_000);

  it('reports an early child exit and bounded stderr instead of a network-zero timeout', async () => {
    const { origin } = await reserveStlOrigin();
    const server = launch(`process.stderr.write('x'.repeat(20000) + '\\nfixture startup failed\\n'); process.exit(23)`);
    try {
      await expect(server.ready(origin, 8000)).rejects.toThrow(/exited before readiness:[\s\S]*exit=23[\s\S]*fixture startup failed/);
    } finally { await server.stop(); }
  });

  it('does not accept an unauthenticated or wrong-policy listener', async () => {
    const { port, origin } = await reserveStlOrigin();
    const server = launch(`require('http').createServer((req, res) => { res.writeHead(200); res.end(); }).listen(${port}, '127.0.0.1')`);
    try { await expect(server.ready(origin, 3000)).rejects.toThrow('expected HTTP 401, got HTTP 200'); }
    finally { await server.stop(); }
  });

  it('reaps a child that ignores graceful shutdown', async () => {
    const { port, origin } = await reserveStlOrigin();
    const server = launch(`process.on('SIGTERM', () => {}); require('http').createServer((req, res) => { res.writeHead(401); res.end(); }).listen(${port}, '127.0.0.1')`);
    try { await server.ready(origin, 3000); } finally { await server.stop(); }
    expect(server.child.signalCode).toBe('SIGKILL');
    expect(() => process.kill(server.child.pid!, 0)).toThrow();
  });

  it('bounds readiness and includes the actual connection error when a child stays alive without listening', async () => {
    const { origin } = await reserveStlOrigin();
    const server = launch(`console.error('fixture stuck before listen'); setInterval(() => {}, 1000)`);
    try { await expect(server.ready(origin, 500)).rejects.toThrow(/not ready within 500ms; last probe:[\s\S]*ECONNREFUSED[\s\S]*fixture stuck before listen/); }
    finally { await server.stop(); }
  });
});

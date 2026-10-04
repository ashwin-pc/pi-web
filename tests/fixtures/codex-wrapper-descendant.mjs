import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(child.pid));
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
  if (process.argv[3] === 'natural') setTimeout(() => process.exit(0), 100);
});
input.once('close', () => process.exit(0));

#!/usr/bin/env node
/** Actual CLI pass-through capture, never a synthetic peer. Opt-in only. */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.env.PI_WEB_KIRO_ACTUAL_CANARY !== '1') throw Error('Actual canary not authorized');
const args = process.argv.slice(2);
if (![JSON.stringify(['--version']), JSON.stringify(['chat','--agent-engine','v2','--list-sessions','--format','json']), JSON.stringify(['acp','--agent-engine','v2'])].includes(JSON.stringify(args))) throw Error('Unapproved native arguments');
const acp = args[0] === 'acp';
const child = spawn('kiro-cli', args, { stdio: ['pipe','pipe','pipe'], env: process.env });
const capture = (direction, raw) => appendFileSync(process.env.PI_WEB_KIRO_CANARY_RAW, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, direction, raw })+'\n', { mode: 0o600 });
appendFileSync(process.env.PI_WEB_KIRO_CANARY_LAUNCHES, JSON.stringify({ pid: process.pid, childPid: child.pid, args, hostTokenPresent: Object.keys(process.env).some(k => k.toUpperCase() === 'PI_WEB_TOKEN') })+'\n', {mode:0o600});
child.stderr.on('data', data => appendFileSync(process.env.PI_WEB_KIRO_CANARY_STDERR, data, {mode:0o600}));
if (acp) {
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'session/prompt') {
      const ledger = JSON.parse(readFileSync(process.env.PI_WEB_KIRO_CANARY_BUDGET, 'utf8'));
      const raw = readFileSync(process.env.PI_WEB_KIRO_CANARY_RAW, 'utf8');
      const sent = raw.split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(r => r.direction === 'send' && JSON.parse(r.raw).method === 'session/prompt').length;
      if (ledger.submitted > 4 || sent >= ledger.submitted) { child.kill('SIGTERM'); throw Error('Unreserved prompt blocked'); }
    }
    capture('send', line); child.stdin.write(line+'\n');
  }).on('close', () => child.stdin.end());
  createInterface({ input: child.stdout }).on('line', line => { capture('receive', line); process.stdout.write(line+'\n'); });
} else {
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  if (args[0] === 'chat') {
    let text = '';
    child.stdout.on('data', data => { text += data; });
    child.stdout.on('end', () => appendFileSync(process.env.PI_WEB_KIRO_CANARY_RAW+'.catalog', JSON.stringify(JSON.parse(text))+'\n', {mode:0o600}));
  }
}
child.stdin.on('error', () => {});
child.on('close', code => process.exit(code ?? 1));

/** Opt-in actual Kiro browser canary. Run in owned tmux, never npm test.
 * PI_WEB_KIRO_ACTUAL_CANARY=1 node tests/kiro-actual-canary.mjs [--continue]
 * Native HOME/config are inherited. Persistent budget is never reset.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, lstatSync, rmSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
assert.equal(process.env.PI_WEB_KIRO_ACTUAL_CANARY, '1', 'Explicit actual canary authorization required');
const repository = resolve(import.meta.dirname, '..');
const output = join(repository, '.pi/web/artifacts/kiro-actual-canary'); mkdirSync(output, { recursive: true });
const budgetFile = join(output, 'budget.json');
if (!existsSync(budgetFile)) writeFileSync(budgetFile, JSON.stringify({ submitted: 0, limit: 4, reservations: [] }, null, 2)+'\n', { flag: 'wx' });
const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
assert(budget.submitted < 4, 'Four-turn budget exhausted. Never reset this ledger.');
const continuation = process.argv.includes('--continue');
assert(continuation || budget.submitted === 0, 'Use explicit continuation; never replay consumed turns');
const manifestFile = join(output, 'continuation.json');
const saved = continuation ? JSON.parse(readFileSync(manifestFile, 'utf8')) : undefined;
const root = saved?.root ?? mkdtempSync('/tmp/pi-web-kiro-canary-');
const cwd = join(root, 'workspace'); mkdirSync(cwd, { recursive: true });
const marker = saved?.marker ?? `KIRO_CANARY_${randomBytes(8).toString('hex')}`;
if (!saved) writeFileSync(join(cwd, 'canary.txt'), marker+'\n', {mode:0o600});
const rawFile = join(root, 'frames-private.jsonl'); if (!existsSync(rawFile)) writeFileSync(rawFile, '', {mode:0o600});
const token = randomBytes(32).toString('hex');
const port = 21941; const origin = `http://127.0.0.1:${port}`;
const reportFile = join(output, 'report.json');
const report = saved ? JSON.parse(readFileSync(reportFile, 'utf8')) : { startedAt: new Date().toISOString(), nativeLaunch: 'kiro-cli acp --agent-engine v2', port, turns: [], assertions: {}, sensitivePresence: {}, cleanup: [] };
report.verdict = 'RUNNING'; delete report.blocker;
const checks = report.assertions;
let server, browser, page, watchdog, timedOut = false, authorizedPrompt;
let sessionId = saved?.sessionId, nativeId = saved?.nativeId;
let phase = 'setup'; let entry; let browserPrompts = 0;
const presence = report.sensitivePresence;
function redact(text) {
  text = String(text).split(token).join('[WEB_TOKEN]');
  const rules = [ ['home', /\/(?:local\/)?home\/[^\s/"'\\]+/g, '<HOME>'], ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'], ['accountId', /(?<![\w-])\d{12}(?![\w-])/g, '[ACCOUNT]'], ['credentials', /\b(?:Bearer|Basic)\s+[^\s,"'\\}]+/gi, '[CREDENTIAL]'], ['accessKey', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[ACCESS_KEY]'], ['tokenValue', /((?:accessToken|refreshToken|apiKey|api_key|authorization|password|secret|token)\\?"?\s*[:=]\s*\\?")[^"\\]*(?:\\.[^"\\]*)*/gi, '$1[REDACTED]'] ];
  for (const [name, regex, replacement] of rules) { regex.lastIndex = 0; if (regex.test(text)) presence[name] = true; regex.lastIndex = 0; text = text.replace(regex, replacement); }
  for (const key of ['home','email','accountId','credentials','accessKey','tokenValue']) presence[key] ??= false;
  return text;
}
const privateLog = join(root, 'app-private.log');
function save() {
  writeFileSync(reportFile, redact(JSON.stringify(report, null, 2))+'\n');
  writeFileSync(manifestFile, JSON.stringify({root, marker, sessionId, nativeId}, null, 2)+'\n');
  const frames = readFileSync(rawFile, 'utf8').split('\n').filter(Boolean).map(line => { const r = JSON.parse(line); r.raw = redact(r.raw); return JSON.stringify(r); }).join('\n');
  writeFileSync(join(output, 'frames-redacted.jsonl'), frames+'\n');
}
function inventory() {
  const result = {};
  const visit = (path, relative = '') => { let names; try { names = readdirSync(path); } catch { return; }
    for (const name of names) { const file = join(path,name), rel = join(relative,name); let stat; try { stat = lstatSync(file); } catch { continue; }
      result[rel] = { type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mtime: stat.mtime.toISOString() };
      if (stat.isDirectory()) visit(file,rel);
    }
  }; visit(join(process.env.HOME,'.kiro')); return result;
}
const beforeNative = inventory();
const inherited = {...process.env}; for (const k of Object.keys(inherited)) if (k.startsWith('PI_')) delete inherited[k];
const env = { ...inherited, NODE_ENV:'production', HOST:'127.0.0.1', PORT:String(port), PI_WEB_DEV:'0', PI_WEB_MOCK:'0', PI_WEB_MULTI_HARNESS:'1', PI_WEB_CWD:cwd,
  PI_CODING_AGENT_DIR:join(root,'pi-agent'), PI_CODING_AGENT_SESSION_DIR:join(root,'pi-sessions'), PI_WEB_TOKEN:token,
  PI_WEB_AUTH_MODE:'legacy', PI_WEB_AUTH_POLICY:'authenticated', PI_WEB_AUTH_METHODS:'legacy', PI_WEB_AUTH_ORIGIN:origin,
  PI_WEB_AUTH_STORE:join(root,'auth.json'), PI_WEB_AUTH_TRUSTED_HEADER:'', PI_WEB_AUTH_PROXY_PEERS:'',
  PI_WEB_SETTINGS_FILE:join(root,'settings.json'), PI_WEB_SESSION_UI_STATE_FILE:join(root,'ui.json'), PI_WEB_NATIVE_BINDINGS_FILE:join(root,'bindings.json'), PI_WEB_PUSH_FILE:join(root,'push.json'),
  PI_WEB_NOTEPAD_DIR:join(root,'notepad'), PI_WEB_NOTEPAD_DB:join(root,'notepad-db.json'), PI_WEB_NOTEPAD_VAULT:join(root,'vault'), PI_WEB_DELEGATION_SPOOL:join(root,'spool'),
  PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1', PI_TELEMETRY:'0', PI_WEB_KIRO_ACTUAL_CANARY:'1',
  PI_WEB_KIRO_COMMAND:join(repository,'tests/fixtures/kiro-canary-cli.mjs'), PI_WEB_KIRO_CANARY_RAW:rawFile,
  PI_WEB_KIRO_CANARY_LAUNCHES:join(root,'launches.jsonl'), PI_WEB_KIRO_CANARY_STDERR:join(root,'native-private.log'), PI_WEB_KIRO_CANARY_BUDGET:budgetFile };
async function api(path, data) {
  const response = await fetch(origin+path, { headers: { authorization:`Bearer ${token}`, ...(data ? {'content-type':'application/json'} : {}) }, ...(data ? {method:'POST',body:JSON.stringify(data)} : {}), signal:AbortSignal.timeout(5000) });
  assert(response.ok, `API ${path.split('?')[0]} status ${response.status}`); return response.json();
}
const state = () => api(`/api/state?sessionId=${sessionId}`);
const messages = async () => (await api(`/api/messages?sessionId=${sessionId}`)).messages;
function processes() { return execFileSync('ps',['-eo','pid,ppid,comm'],{encoding:'utf8'}).trim().split('\n').slice(1).map(line => { const [pid,ppid,comm] = line.trim().split(/\s+/); return {pid:Number(pid),ppid:Number(ppid),comm}; }); }
function proc(pid) { try { const fields = readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' '); return {state:fields[0], start:fields[19]}; } catch { return {}; } }
async function stop() {
  const child = server; server = undefined; if (!child?.pid) return;
  const rows = processes(), owned = new Set([child.pid]);
  for (let changed=true;changed;) { changed=false; for (const r of rows) if (owned.has(r.ppid)&&!owned.has(r.pid)) {owned.add(r.pid);changed=true;} }
  const targets = rows.filter(r => owned.has(r.pid)).map(r => ({...r,...proc(r.pid)}));
  child.kill('SIGTERM');
  const deadline=Date.now()+12000; while (proc(child.pid).state && proc(child.pid).state!=='Z' && Date.now()<deadline) await delay(100);
  for (const r of targets.reverse()) { const current=proc(r.pid); if (current.start===r.start && current.state && current.state!=='Z') {try {process.kill(r.pid,'SIGKILL');} catch {}} }
  await delay(200);
  report.cleanup.push(...targets.map(r => ({pid:r.pid,command:r.comm,running:proc(r.pid).start===r.start && !!proc(r.pid).state && proc(r.pid).state!=='Z'})));
}
async function start() {
  const log = openSync(privateLog,'a',0o600);
  server = spawn(process.execPath,['--import','tsx','server.ts'],{cwd:repository,env,stdio:['ignore',log,log],detached:true}); closeSync(log);
  const deadline = Date.now()+45000;
  while (Date.now()<deadline) { assert.equal(server.exitCode,null,'Owned app exited'); try {await api('/api/harnesses');return;} catch {await delay(150);} }
  throw Error('Owned app readiness timeout');
}
async function screenshot(name) {
  // DOM redaction only for screenshots; no changed network responses or transcript fixtures.
  await page.evaluate(() => { const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); while(walk.nextNode()) {const n=walk.currentNode;n.textContent=n.textContent.replace(/\/(?:local\/)?home\/[^\s/]+/g,'<HOME>').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]');} });
  await page.screenshot({path:join(output,`${name}.png`)});
}
async function submit(name,text,first=false) {
  assert(budget.submitted<4,'Four-turn budget exhausted');
  entry = {number:budget.submitted+1,name,status:'RUNNING',startedAt:new Date().toISOString(),permissionRequests:[]}; report.turns.push(entry); phase=name;
  await page.locator('#prompt').fill(text);
  // Reserve and fsync before the first UI action capable of dispatching input.
  budget.submitted++; budget.reservations.push({number:budget.submitted,name,at:new Date().toISOString()});
  const fd=openSync(budgetFile+'.tmp','w',0o600);writeFileSync(fd,JSON.stringify(budget,null,2)+'\n');fsyncSync(fd);closeSync(fd);renameSync(budgetFile+'.tmp',budgetFile);
  const directory=openSync(output,'r');fsyncSync(directory);closeSync(directory);
  save(); authorizedPrompt=text;
  watchdog=setTimeout(() => {timedOut=true;entry.status='FAIL';entry.failure='120-second watchdog';void stop();},120000);
  const creation = first ? page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions/new'&&r.request().method()==='POST',{timeout:60000}) : undefined;
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/prompt'&&r.request().method()==='POST',{timeout:120000});
  await page.locator('#primaryButton').click();
  if (creation) {const created=await(await creation).json(); sessionId=created.sessionId;nativeId=created.nativeSession.sessionId;checks.landingCreation=created.harnessId==='kiro'&&sessionId!==nativeId&&!created.sessionFile;report.nativeSettings=created.nativeSettings;save();}
  const result=await response;assert.equal(result.status(),202,'Prompt HTTP acceptance');entry.receipt=await result.json();save();
}
async function tick() {
  assert(!timedOut,'120-second watchdog expired');
  const s=await state();
  for(const pending of s.pendingInteractions??[]) {
    const meaning=phase==='approval'&&entry.permissionRequests.length===0?'decline':'accept';
    const context=JSON.parse(pending.body);
    const input=context.toolCall.rawInput;
    const ownedRead=context.toolCall.kind==='read' && JSON.stringify(Object.keys(input))===JSON.stringify(['operations'])
      && Array.isArray(input.operations) && input.operations.length===1
      && Object.keys(input.operations[0]).every(k=>['mode','path'].includes(k)) && input.operations[0].mode==='Line'
      && ['canary.txt',join(cwd,'canary.txt')].includes(input.operations[0].path);
    const ownedWrite=context.toolCall.kind==='edit' && Object.keys(input).every(k=>['command','path','content'].includes(k))
      && input.command==='create' && ['approved.txt',join(cwd,'approved.txt')].includes(input.path) && input.content==='HARMLESS_WRITE\n';
    assert(phase==='generation-read'?ownedRead:phase==='approval'&&ownedWrite,'Only the exact harmless owned file action may be decided');
    if(meaning==='accept') assert(phase==='generation-read'||phase==='approval','Unexpected permission outside owned actions');
    const choice=pending.choices.find(c=>c.meaning===meaning&&c.scope==='once'); assert(choice,`No exact ${meaning} once choice`);
    await screenshot(`turn-${entry.number}-permission-${entry.permissionRequests.length+1}`);
    await page.locator(`[data-request-id="${pending.id}"] [data-choice-id="${choice.id}"]`).click();
    if(meaning==='decline') {await delay(300);entry.declinedFileAbsent=!existsSync(join(cwd,'approved.txt'));assert(entry.declinedFileAbsent,'Declined file was written');}
    entry.permissionRequests.push({meaning,kind:context.toolCall.kind,choices:pending.choices,exactNativeOptions:context.options});save();
  }
  assert(!s.error&&s.phase!=='unavailable'&&s.phase!=='error',`Native state ${s.phase}: ${s.error??''}`); return s;
}
async function idle() {while(true) {const s=await tick();if(s.phase==='idle'&&!s.isStreaming&&!s.activeExecution){clearTimeout(watchdog);return s;} await delay(100);}}
async function finish() {entry.status='PASS';entry.finishedAt=new Date().toISOString();entry.stopReasons=[...new Set((await messages()).filter(m=>m.executionId===entry.receipt.executionId).map(m=>m.stopReason).filter(Boolean))];await expect(page.locator('#stopButton')).toBeHidden();await screenshot(`turn-${entry.number}-${phase}`);save();}
async function drawerOpen() {
  if(await page.locator('#sessionDrawer').isHidden()) await page.locator('#sessionButton').click();
  await page.locator(`.sessionItem[data-session-id="${sessionId}"] .sessionItemNavBtn`).click();
  if(await page.locator('#sessionDrawer').isVisible()) await page.locator('#sessionButton').click();
  await expect.poll(async()=>(await state()).phase).toBe('idle');
}
try {
  save(); await start();
  assert.equal((await fetch(origin+'/api/harnesses')).status,401);checks.unauthenticatedDenied=true;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({baseURL:origin,viewport:{width:1280,height:900},serviceWorkers:'block'});
  page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('console',m=>appendFileSync(join(root,'browser-private.log'),`${m.type()}: ${m.text()}\n`,{mode:0o600}));
  page.on('pageerror',e=>appendFileSync(join(root,'browser-private.log'),`error: ${e.message}\n`,{mode:0o600}));
  await page.route(origin+'/api/prompt',async route=>{const data=route.request().postDataJSON();if(!authorizedPrompt||data.message!==authorizedPrompt||data.mode!=='prompt'||(sessionId&&data.sessionId!==sessionId)){report.unexpectedPromptBlocked=true;await route.abort();return;}authorizedPrompt=undefined;browserPrompts++;await route.continue();});
  await page.goto('/');await page.locator('#tokenInput').fill(token);await page.locator('#tokenForm button[type=submit]').click();await expect(page.locator('#tokenOverlay')).toBeHidden();
  checks.normalBrowserAuthentication=(await context.cookies()).some(c=>c.name==='pi_web_session');
  if(saved) {
    await drawerOpen();
    if (budget.submitted===1 && report.turns[0]?.markerInReply && report.turns[0]?.nativeSettingsVisible) {
      // Recover only remaining zero-model assertions after the first attempt's
      // popover-dismissal harness error. Never resend the consumed native input.
      entry=report.turns[0];phase=entry.name;
      entry.initialHarnessFailure=entry.failure;delete entry.failure;
      const history=await messages();assert(history.some(m=>m.role==='assistant'&&m.text?.includes(marker)));
      entry.loadedReadResult=history.flatMap(m=>m.parts??[]).some(p=>p.type==='toolCall'&&p.result?.parts.some(c=>c.type==='text'&&c.text.includes(marker)));
      const listing=await api('/api/sessions');entry.publicCatalogBinding=listing.sessions.some(s=>s.nativeSession?.sessionId===nativeId);
      const catalogs=readFileSync(rawFile+'.catalog','utf8').trim().split('\n').map(s=>JSON.parse(s));
      entry.publicCatalogSource=catalogs.flatMap(groups=>groups).filter(g=>g.cwd===cwd).flatMap(g=>g.sessions).find(s=>s.sessionId===nativeId)?.source;assert.equal(entry.publicCatalogSource,'v2');
      entry.stopReasons=['end_turn'];entry.status='PASS';await screenshot('turn-1-recovered');save();
    }
  }
  if(budget.submitted===0) {
    await expect(page.locator('[data-harness-selector="landing"] select')).toHaveValue('pi');await page.locator('[data-harness-selector="landing"] select').selectOption('kiro');
    await submit('generation-read','Read canary.txt in the current workspace using your native file read tool, then reply with exactly its single line. Do not inspect other files, use network, or change files.',true);
    await idle();const ms=await messages();
    entry.markerInReply=ms.some(m=>m.role==='assistant'&&m.text?.includes(marker));assert(entry.markerInReply,'Marker missing from native reply');
    entry.nativeReadTool=ms.flatMap(m=>m.parts??[]).some(p=>p.type==='toolCall'&&p.status==='completed');assert(entry.nativeReadTool,'Completed native tool missing');
    entry.fileUnchanged=readFileSync(join(cwd,'canary.txt'),'utf8')===marker+'\n';assert(entry.fileUnchanged);
    await expect(page.locator('#messages')).toContainText(marker);await expect(page.locator('.toolCard').first()).toBeVisible();
    await page.locator('#modelSettingsButton').click();await expect(page.locator('.modelSettingsNative')).toContainText(`Model: ${report.nativeSettings.model}`);await expect(page.locator('.modelSettingsNative')).toContainText(`Mode: ${report.nativeSettings.mode}`);entry.nativeSettingsVisible=true;await screenshot('turn-1-settings');await page.getByText(marker,{exact:true}).last().click();
    const listing=await api('/api/sessions');entry.publicCatalogBinding=listing.sessions.some(s=>s.nativeSession?.sessionId===nativeId);assert(entry.publicCatalogBinding);
    const catalogs=readFileSync(rawFile+'.catalog','utf8').trim().split('\n').map(s=>JSON.parse(s));
    entry.publicCatalogSource=catalogs.flatMap(groups=>groups).filter(g=>g.cwd===cwd).flatMap(g=>g.sessions).find(s=>s.sessionId===nativeId)?.source;
    assert.equal(entry.publicCatalogSource,'v2');
    await finish();
  }
  if(budget.submitted===1) {
    await submit('approval','Create approved.txt in this workspace with exactly the line HARMLESS_WRITE using your native file write tool. Do not touch other files or use network. If permission is denied, do not retry or use an alternative tool; just report that it was denied.');
    await idle();entry.fileWritten=existsSync(join(cwd,'approved.txt'));entry.permissionStatus=entry.permissionRequests.length?'ENCOUNTERED':'NOT ENCOUNTERED';
    if(entry.permissionRequests.length===1&&entry.permissionRequests[0].meaning==='decline')assert(!entry.fileWritten,'Decline must prevent write');
    await finish();
  }
  if(budget.submitted===2) {
    await submit('stream-stop','Do not use tools. Begin immediately with STREAM_STOP_CANARY, then write 1000 numbered lines, each containing a distinct short sentence about a neutral everyday object. Do not stop early.');
    while(true) {const s=await tick();const text=(await messages()).filter(m=>m.executionId===entry.receipt.executionId&&m.role==='assistant').map(m=>m.text??'').join('');if(text.length>30&&await page.locator('#stopButton').isVisible()){entry.partialBeforeStop=text;break;}assert(s.activeExecution,'Turn finished before visible Stop');await delay(30);}
    await expect(page.locator('#messages')).toContainText('STREAM_STOP_CANARY');await screenshot('turn-3-streaming');
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/abort'&&r.request().method()==='POST');await page.locator('#stopButton').click();const r=await response;entry.abortStatus=r.status();entry.abortGuard=r.request().postDataJSON().expectedExecutionId;assert.equal(entry.abortGuard,entry.receipt.executionId);assert.equal(r.status(),202);
    await idle();entry.partialAfterStop=(await messages()).filter(m=>m.executionId===entry.receipt.executionId&&m.role==='assistant').map(m=>m.text??'').join('');assert(entry.partialAfterStop.startsWith(entry.partialBeforeStop));
    assert(!(await messages()).flatMap(m=>m.parts??[]).some(p=>p.type==='toolCall'&&p.status==='running'));await page.reload();await expect(page.locator('#messages')).toContainText('STREAM_STOP_CANARY');entry.partialAfterReload=(await messages()).some(m=>m.text?.includes(entry.partialBeforeStop));assert(entry.partialAfterReload);await finish();
  }
  if(budget.submitted===3) {
    phase='cold-restart';const before=await messages();await stop();await start();await page.goto('/');
    if(await page.locator('#tokenOverlay').isVisible()){await page.locator('#tokenInput').fill(token);await page.locator('#tokenForm button[type=submit]').click();}
    await drawerOpen();const history=await messages();
    const content=ms=>ms.map(m=>({role:m.role,text:m.text,tools:(m.parts??[]).filter(p=>p.type==='toolCall').map(p=>({toolName:p.toolName,args:p.args,result:p.result}))}));
    checks.coldHistoryExact=JSON.stringify(content(before))===JSON.stringify(content(history));
    checks.coldHistoryMarker=history.some(m=>m.role==='assistant'&&m.text?.includes(marker));
    checks.coldHistoryTools=history.some(m=>(m.parts??[]).some(p=>p.type==='toolCall'));
    checks.coldStoppedPartialRetained=history.some(m=>m.text?.includes(report.turns.find(t=>t.name==='stream-stop')?.partialBeforeStop));
    checks.coldNativeInterruptionPlaceholder=history.some(m=>m.text==='Response was interrupted by the user');
    checks.coldSameNativeId=(await state()).nativeSession.sessionId===nativeId;checks.coldNoPromptReplay=budget.submitted===3;
    await screenshot('cold-restart-history');save();
    assert(checks.coldHistoryMarker,'Cold native history lacks marker');
    await submit('resume','Do not use tools. What was the exact single line you read from canary.txt earlier in this conversation? Reply only with that line.');await idle();
    entry.markerRecalled=(await messages()).some(m=>m.executionId===entry.receipt.executionId&&m.role==='assistant'&&m.text?.includes(marker));assert(entry.markerRecalled,'Native resume did not recall marker');await finish();
  }
  report.verdict=report.turns.every(t=>t.status==='PASS')&&checks.coldHistoryExact?'PASS':'PARTIAL';
} catch(error) {
  report.verdict='BLOCKED';report.blocker=redact(error.message);report.blockedPhase=phase;if(entry&&entry.status==='RUNNING'){entry.status='FAIL';entry.failure=report.blocker;}
  try{if(page)await screenshot(`blocked-${budget.submitted}`);}catch{}
  process.exitCode=1;
} finally {
  clearTimeout(watchdog);await stop();await browser?.close().catch(()=>{});
  report.submittedTurns=budget.submitted;report.browserPromptsThisAttempt=browserPrompts;report.finishedAt=new Date().toISOString();
  const afterNative=inventory();report.nativeSideEffects={newEntries:Object.entries(afterNative).filter(([k])=>!beforeNative[k]),modifiedEntries:Object.entries(afterNative).filter(([k,v])=>beforeNative[k]&&beforeNative[k].mtime!==v.mtime),removedEntries:Object.keys(beforeNative).filter(k=>!afterNative[k]),attribution:'Observation window only; concurrent native processes may contribute. Names and mtimes only; contents never read.'};
  report.launches=existsSync(join(root,'launches.jsonl'))?readFileSync(join(root,'launches.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  const frames=readFileSync(rawFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
  report.actualPromptFrames=frames.filter(r=>r.direction==='send'&&JSON.parse(r.raw).method==='session/prompt').length;
  report.frameShapes=frames.map(r=>{const m=JSON.parse(r.raw);return{direction:r.direction,method:m.method,variant:m.params?.update?.sessionUpdate,resultKeys:m.result?Object.keys(m.result):undefined,stopReason:m.result?.stopReason};}).filter(r=>r.variant||r.stopReason||['session/prompt','session/cancel','session/request_permission','session/load'].includes(r.method));
  for(const [source,target]of[['app-private.log','app-redacted.log'],['browser-private.log','browser-redacted.log'],['native-private.log','native-stderr-redacted.log']])writeFileSync(join(output,target),redact(existsSync(join(root,source))?readFileSync(join(root,source),'utf8'):''));
  save();console.log(JSON.stringify({verdict:report.verdict,phase,submitted:budget.submitted,blocker:report.blocker,output}));
  // Keep failed attempts' owned state for an explicit remaining-budget continuation.
  if(report.verdict==='PASS'||budget.submitted===4){rmSync(root,{recursive:true,force:true});report.scratchRemoved=true;writeFileSync(reportFile,redact(JSON.stringify(report,null,2))+'\n');}
}

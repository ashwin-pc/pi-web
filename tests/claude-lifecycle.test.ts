// Regression port of the independent verifier's three lifecycle probes.
// Real SDK -> production handle/service/host; synthetic native ingress and
// supported-reader seam, never actual generation or private-store evidence.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it } from 'vitest';
import { createMockHarness } from '../server/mock.js';
import { createPiAdapter } from '../server/session/adapters/pi/index.js';
import { createClaudeAdapter } from '../server/session/adapters/claude/index.js';
import { LocalSessionService } from '../server/session/service.js';
import { SessionActivity } from '../server/session/activity.js';
import { createHostSessionEventHandler } from '../server/session/hostEvents.js';
import { ClaudeNativePeer } from './fixtures/claude-native-peer.js';

const observations: Record<string, unknown>[]=[];
const originalSettings = process.env.PI_WEB_SETTINGS_FILE;
afterEach(() => { if (originalSettings === undefined) delete process.env.PI_WEB_SETTINGS_FILE; else process.env.PI_WEB_SETTINGS_FILE = originalSettings; });
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
async function until(test:()=>boolean|Promise<boolean>,description:string) {
 const deadline=Date.now()+5000;
 while(!await test()) { if(Date.now()>deadline) throw new Error(`Diagnostic setup timed out: ${description}`); await pause(); }
}
async function fixture(controlTimeoutMs=1500) {
 const root=await mkdtemp(join(tmpdir(),'pi92-independent-claude-'));
 process.env.PI_WEB_SETTINGS_FILE=join(root,'settings.json');
 const mock=createMockHarness({piCwd:root});
 let piCreations=0;
 const pi=createPiAdapter({modelRuntime:{} as Parameters<typeof createPiAdapter>[0]['modelRuntime'],
  peer:{create:async({path})=>{piCreations++;return{session:mock.createMockSession(path)};},list:async()=>mock.mockSessions,newSessionAfterCreate:true},
  additionalExtensionPaths:()=>[],defaultsFor:async()=>({}),globalCwd:()=>root,clientCount:()=>1});
 const peers:ClaudeNativePeer[]=[];
 let nativeInfo:SDKSessionInfo|undefined;
 let nativeHistory:SessionMessage[]=[];
 const reads={info:0,messages:0};
 const claude=createClaudeAdapter({pathToClaudeCodeExecutable:process.execPath,controlTimeoutMs,
  env:{CLAUDE_CONFIG_DIR:root,DISABLE_TELEMETRY:'1'},
  spawnClaudeCodeProcess:()=>{const peer=new ClaudeNativePeer();peers.push(peer);return peer;},
  sessionApi:{getSessionInfo:async()=>{reads.info++;return nativeInfo;},getSessionMessages:async()=>{reads.messages++;return nativeHistory;},listSessions:async()=>nativeInfo?[nativeInfo]:[]}});
 const service=new LocalSessionService({pi,adapters:[claude],nativeBindingsFile:join(root,'bindings.json'),multiHarnessEnabled:true,finalizeCreatedSession:async()=>undefined,globalCwd:()=>root});
 const wire:any[]=[];
 const activity=new SessionActivity(id=>service.sessionForPath(id)?.state());
 service.subscribe(createHostSessionEventHandler({sessionForId:id=>service.sessionForId(id),projectState:h=>service.projectState(h),webUiEntries:h=>service.webUiEntries(h),sessionActivity:activity,broadcast:value=>wire.push(value),markSessionUnreadCompleted:()=>undefined}));
 const created=await service.create(undefined,root,'claude');
 const id=created.sessionId;
 const nativeId=created.nativeSession!.sessionId!;
 const prompt=(label:string)=>service.prompt(id,{message:label,mode:'prompt',attachments:[],clientMessageId:`client-${label}`,sourceClientId:'independent-browser'});
 const send=(value:Record<string,unknown>)=>peers[0]!.send({uuid:randomUUID(),session_id:nativeId,...value});
 const assistant=(apiId:string,content:unknown[])=>({type:'assistant',parent_tool_use_id:null,message:{id:apiId,role:'assistant',model:'claude-fixture',content,stop_reason:null,usage:{}}});
 const result=(userId:string,index:number,extra:Record<string,unknown>={})=>send({type:'result',subtype:'success',is_error:false,result:'done',user_message_uuid:userId,result_index:index,duration_ms:1,duration_api_ms:1,num_turns:1,stop_reason:'end_turn',total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[],...extra});
 const idle=()=>send({type:'system',subtype:'session_state_changed',state:'idle'});
 const start=async(label:string)=>{const receipt=await prompt(label);const user=await peers[0]!.nextInput(m=>m.type==='user'&&m.message.content===label);if(user.type!=='user'||!user.uuid)throw new Error('Missing native input');send({...user,isReplay:true});await until(async()=>Boolean((await service.messages(id)).find(m=>m.role==='user'&&m.text===label)),'native acknowledgement');return{receipt,user};};
 const snapshot=()=>service.state(id);
 return {root,service,peers,wire,reads,id,nativeId,prompt,send,assistant,result,idle,start,snapshot,
  history(info:SDKSessionInfo,history:SessionMessage[]){nativeInfo=info;nativeHistory=history;},
  async close(){await service.disposeAll();if(piCreations)throw new Error('Unexpected Pi fallback');await rm(root,{recursive:true,force:true});}};
}

async function processDeathReopen() {
 const f=await fixture();
 try {
  const {user}=await f.start('recover');
  f.send(f.assistant('api-recovery',[{type:'text',text:'Observed before process loss'},{type:'tool_use',id:'unfinished-tool',name:'Bash',input:{command:'printf synthetic'}}]));
  await until(async()=>(await f.service.messages(f.id)).some(m=>m.parts?.some(p=>p.type==='toolCall')),'tool projection');
  f.peers[0]!.exit(42);
  await until(async()=>!((await f.snapshot()).isStreaming),'process exit');
  const deadMessages = await f.service.messages(f.id);
  const deadTool = deadMessages.flatMap(message => message.parts ?? []).find(part => part.type === 'toolCall');
  expect(deadTool).toMatchObject({ type: 'toolCall', status: 'error' });
  expect(deadTool).not.toHaveProperty('result'); // Lost completion is not fabricated output.
  expect(f.peers).toHaveLength(1);
  await f.service.state(f.id); await f.service.messages(f.id);
  expect(f.peers).toHaveLength(1); // Passive reads never respawn/replay the prompt.
  f.history({sessionId:f.nativeId,cwd:f.root,summary:'Authoritative native recovery',lastModified:1000},[
   {type:'user',uuid:user.uuid!,session_id:f.nativeId,parent_tool_use_id:null,parent_agent_id:null,message:{role:'user',content:'recover'}},
   {type:'assistant',uuid:randomUUID(),session_id:f.nativeId,parent_tool_use_id:null,parent_agent_id:null,message:{id:'api-recovery',role:'assistant',content:[{type:'text',text:'Authoritative native history after process loss'}]}}
  ]);
  const before=await f.snapshot(); const beforeReads={...f.reads};
  const opened=await f.service.open(f.id);
  const messages=await f.service.messages(f.id);
  const dangling=messages.flatMap(m=>m.parts??[]).filter(p=>p.type==='toolCall'&&p.status==='running');
  const recoveryWorked=f.reads.messages>beforeReads.messages&&messages.some(m=>m.text==='Authoritative native history after process loss');
  expect(opened.nativeSession.sessionId).toBe(f.nativeId);
  expect(f.peers).toHaveLength(1); // Opening uses SDK readers, not automatic input.
  expect(messages.some(message => message.text === 'Observed before process loss')).toBe(false);
  observations.push({case:'persistent-process-death-explicit-open',expected:'Explicit open reloads authoritative supported native history',observed:{beforePhase:before.phase,afterPhase:opened.phase,readerCallsBefore:beforeReads,readerCallsAfter:{...f.reads},messages:messages.map(m=>({role:m.role,text:m.text,status:m.status,parts:m.parts})),danglingRunningTools:dangling.length},pass:recoveryWorked});
  observations.push({case:'process-death-terminal-tool-status',expected:'A dead process must not leave a live-running tool card',observed:{sessionPhase:opened.phase,isStreaming:opened.isStreaming,toolStatus:dangling.map(p=>p.type==='toolCall'?p.status:undefined)},pass:dangling.length===0});
 } finally {await f.close();}
}

async function oldInterruptTimeout() {
 const f=await fixture(1500);
 try {
  const a=await f.start('A');
  const oldInterrupt=f.service.abort(f.id,a.receipt.executionId).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));
  await f.peers[0]!.nextInput(m=>m.type==='control_request'&&m.request.subtype==='interrupt');
  // The native turn completes while its control response remains outstanding.
  f.result(a.user.uuid!,0);f.idle();
  await until(async()=>(await f.snapshot()).phase==='idle','A idle');
  let b:Awaited<ReturnType<typeof f.start>>|undefined;
  let rejected:string|undefined;
  try {b=await f.start('B');} catch(error) {rejected=String(error);}
  const beforeTimeout=await f.snapshot();
  const oldReceipt=await oldInterrupt;
  const afterTimeout=await f.snapshot();
  const bKilled=Boolean(b)&&afterTimeout.activeExecution?.id!==b!.receipt.executionId;
  expect(b).toBeDefined();
  expect(afterTimeout.error).toBeUndefined();
  expect(f.wire.some(event => event.type === 'server_error')).toBe(false);
  f.result(b!.user.uuid!, 1); f.idle();
  await until(async() => (await f.snapshot()).phase === 'idle', 'B remains usable');
  observations.push({case:'old-interrupt-timeout-crosses-execution',expected:'Either B is held until A control settles, or an A timeout cannot mutate/kill B',observed:{bAdmitted:Boolean(b),bRejection:rejected,aExecution:a.receipt.executionId,bExecution:b?.receipt.executionId,beforeTimeout:{phase:beforeTimeout.phase,activeExecution:beforeTimeout.activeExecution},oldReceipt,afterTimeout:{phase:afterTimeout.phase,activeExecution:afterTimeout.activeExecution,error:afterTimeout.error},peerKilled:f.peers[0]!.killed,errorEvents:f.wire.filter(e=>e.type==='error')},pass:!bKilled});
 } finally {await f.close();}
}

async function errorResultToolStatus() {
 const f=await fixture();
 try {
  const a=await f.start('error-tool');
  f.send(f.assistant('api-error-tool',[{type:'tool_use',id:'errored-tool',name:'Read',input:{file_path:'synthetic.txt'}}]));
  f.result(a.user.uuid!,0,{subtype:'error_during_execution',is_error:true,errors:['Synthetic native execution error']});f.idle();
  await until(async()=>!((await f.snapshot()).isStreaming),'terminal error idle');
  const messages=await f.service.messages(f.id);
  const tool=messages.flatMap(m=>m.parts??[]).find(p=>p.type==='toolCall');
  expect(tool).toMatchObject({ status: 'error' });
  expect(tool).not.toHaveProperty('result');
  expect(f.wire.some(event => event.type === 'message_replace' && event.final && event.message.parts?.some((part: { type: string; status?: string }) => part.type === 'toolCall' && part.status === 'error'))).toBe(true);
  // A terminal model error alone does not destroy a healthy transport.
  expect((await f.snapshot()).phase).toBe('error');
  const next = await f.start('after-error');
  expect(f.peers).toHaveLength(1);
  f.result(next.user.uuid!, 1); f.idle();
  await until(async() => (await f.snapshot()).phase === 'idle', 'next prompt after native error');
  observations.push({case:'native-error-terminal-tool-status',expected:'Terminal native failure ends in-flight tool presentation honestly',observed:{sessionPhase:(await f.snapshot()).phase,tool,assistantStatus:messages.find(m=>m.role==='assistant')?.status},pass:tool?.type==='toolCall'&&tool.status!=='running'});
 } finally {await f.close();}
}

it('reloads authoritative native history after process loss and ends unfinished tool presentation', async () => {
 observations.length = 0; await processDeathReopen();
 expect(observations.map(observation => observation.pass)).toEqual([true, true]);
});
it('does not let an old interrupt timeout fail a newly admitted execution', async () => {
 observations.length = 0; await oldInterruptTimeout();
 expect(observations.map(observation => observation.pass)).toEqual([true]);
});
it('ends running tools on a native result failure without fabricating a tool result', async () => {
 observations.length = 0; await errorResultToolStatus();
 expect(observations.map(observation => observation.pass)).toEqual([true]);
});

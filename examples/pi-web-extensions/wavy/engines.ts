import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WavySettings } from "./types.js";
import { SETTINGS_LIMITS, validateSettings } from "./settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK = join(tmpdir(), "wavy-yue-inference.lock");
const YUE_ROOT = () => resolve(process.env.WAVY_YUE_ROOT || join(homedir(), "projects", "yue-local"));
const now = () => new Date().toISOString();
export const WAVY_ENGINE_LIMITS = SETTINGS_LIMITS;
export interface EngineStatus { yue: { available: boolean; inferenceValidated: boolean; root: string; message: string }; sheetsage: { available: boolean; inferenceValidated: boolean; message: string; license: string; modelPath?: string } }
type Progress = (message: string) => void;
type BaseInput = { lyrics: string; style: string; settings: WavySettings; seed: number; outputDir: string };

function exactInteger(value: unknown, name: string, min: number, max: number) { if (!Number.isInteger(value)||(value as number)<min||(value as number)>max) throw new Error(`${name} must be an integer in [${min}, ${max}]`); }
function finite(value: unknown,name:string,min:number,max:number) { if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max) throw new Error(`${name} must be finite in [${min}, ${max}]`); }
function validate(input:BaseInput,operation:"plan"|"render",score?:string) {
  if(!input||typeof input.lyrics!=="string"||!input.lyrics.trim()||typeof input.style!=="string"||!input.style.trim()) throw new Error("lyrics and style must be non-empty strings");
  if(typeof input.outputDir!=="string"||!isAbsolute(input.outputDir)) throw new Error("outputDir must be an absolute dedicated operation directory");
  exactInteger(input.seed,"seed",0,Number.MAX_SAFE_INTEGER); const s=validateSettings(input.settings);
  if(operation==="plan"&&s.planning==="off") throw new Error("planning=off cannot produce a score");
  if(operation==="render"&&score!==undefined&&s.planning==="off") throw new Error("a score requires planning=melody or full");
  if(operation==="render"&&score!==undefined&&!score.length) throw new Error("score must be non-empty when supplied");
}
const delay=(ms:number,signal?:AbortSignal)=>new Promise<void>((ok,bad)=>{const timer=setTimeout(done,ms);const abort=()=>done(signal?.reason??new Error("cancelled"));function done(error?:unknown){clearTimeout(timer);signal?.removeEventListener("abort",abort);error?bad(error):ok();}signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();});
async function acquireLock(signal?:AbortSignal) {
  for(;;){ signal?.throwIfAborted(); let acquired=false; try{await mkdir(LOCK);acquired=true;await writeFile(join(LOCK,"owner.json"),JSON.stringify({pid:process.pid,time:now()}));if(signal?.aborted){await releaseLock();throw signal.reason;}return;}catch(e:any){
    if(e?.name==="AbortError"||signal?.aborted){if(acquired)await releaseLock();throw signal?.reason??e;} if(e.code!=="EEXIST")throw e;
    try{const owner=JSON.parse(await readFile(join(LOCK,"owner.json"),"utf8"));try{process.kill(owner.pid,0);}catch{await releaseLock();continue;}}
    catch{try{if(Date.now()-(await stat(LOCK)).mtimeMs>30_000){await releaseLock();continue;}}catch{continue;}}
    await delay(100,signal);
  }}
}
async function releaseLock(){await rm(LOCK,{recursive:true,force:true});}

async function retainedFile(pathValue: unknown, outputDir: string, label: string, maxBytes: number) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) throw new Error(`Engine returned invalid ${label} path`);
  const [root, target] = await Promise.all([realpath(outputDir), realpath(pathValue)]);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Engine returned ${label} outside outputDir`);
  const info = await stat(target);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error(`Engine returned invalid ${label} file`);
  return target;
}
function finiteResult(value: unknown, label: string, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`Engine returned invalid ${label}`);
  return value;
}
function finishReason(value: unknown) {
  if (value !== "eos" && value !== "cap" && value !== "unknown") throw new Error("Engine returned invalid finishReason");
  return value;
}
function signalGroup(pid:number,signal:NodeJS.Signals){try{process.kill(-pid,signal);return true;}catch{return false;}}
async function terminateGroup(pid:number){signalGroup(pid,"SIGTERM");const end=Date.now()+5000;while(Date.now()<end){await delay(50);try{process.kill(-pid,0);}catch{return;}}signalGroup(pid,"SIGKILL");}

async function runPython(script:string,request:unknown,outputDir:string,signal?:AbortSignal,onProgress?:Progress,python?:string){
  signal?.throwIfAborted(); await mkdir(outputDir,{recursive:true});
  const requestPath=join(outputDir,"request.json"),resultPath=join(outputDir,"result.json"),stdoutPath=join(outputDir,"stdout.log"),stderrPath=join(outputDir,"stderr.log");
  await writeFile(requestPath,JSON.stringify(request,null,2)+"\n");
  const stdout=createWriteStream(stdoutPath,{flags:"a"}),stderr=createWriteStream(stderrPath,{flags:"a"});
  const executable=python||join(YUE_ROOT(),".venv/bin/python");
  const child=spawn(executable,[script,"--root",YUE_ROOT(),"--request",requestPath,"--result",resultPath],{detached:true,stdio:["ignore","pipe","pipe"]});
  let pending="", aborting:Promise<void>|undefined;
  child.stdout!.on("data",chunk=>{stdout.write(chunk);pending=(pending+String(chunk)).slice(-8192);let at:number;while((at=pending.indexOf("\n"))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const event=JSON.parse(line);if(event.message)onProgress?.(`[${event.time||now()}] ${String(event.message)}`);}catch{}}});
  child.stderr!.pipe(stderr,{end:false});
  const abort=()=>{if(child.pid&&!aborting)aborting=terminateGroup(child.pid);}; signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  let code:number|null;
  try{code=await new Promise((ok,bad)=>{child.once("error",bad);child.once("exit",ok);});}
  catch(error){await writeFile(resultPath,JSON.stringify({status:"failed",error:{code:"SPAWN_ERROR",message:String(error)}},null,2)+"\n");throw error;}
  finally{signal?.removeEventListener("abort",abort);child.stdout!.destroy();stderr.end();stdout.end();await Promise.allSettled([finished(stdout),finished(stderr)]);if(aborting)await aborting;}
  if(signal?.aborted){try{await stat(resultPath);}catch{await writeFile(resultPath,JSON.stringify({status:"cancelled",error:{code:"CANCELLED",message:"Engine cancelled"}},null,2)+"\n");}throw signal.reason??new Error("cancelled");}
  let result:any;try{result=JSON.parse(await readFile(resultPath,"utf8"));}catch{result={status:"failed",error:{code:"ENGINE_EXIT",message:`engine exited ${code}; see ${stderrPath}`}};await writeFile(resultPath,JSON.stringify(result,null,2)+"\n");}
  if(code!==0||result.status!=="completed")throw new Error(result?.error?.message||`engine exited ${code}`);return result;
}
async function sheetSageStatus(){
  const python=process.env.WAVY_SHEETSAGE_PYTHON,modelPath=process.env.WAVY_SHEETSAGE_MODEL;
  if(!python||!modelPath)return {available:false,inferenceValidated:false,license:"CC-BY-NC-4.0",message:"Set WAVY_SHEETSAGE_PYTHON and WAVY_SHEETSAGE_MODEL to the isolated Python and reviewed local snapshot. No downloads are performed.",...(modelPath?{modelPath}:{})};
  return await new Promise<any>(resolveStatus=>{const child=spawn(python,[join(HERE,"engine/sheetsage.py"),"--status"],{env:{...process.env,WAVY_SHEETSAGE_MODEL:modelPath},stdio:["ignore","pipe","ignore"]});let out="";child.stdout.on("data",x=>out=(out+String(x)).slice(-65536));const timer=setTimeout(()=>{child.kill();resolveStatus({available:false,inferenceValidated:false,license:"CC-BY-NC-4.0",modelPath,message:"SheetSage status probe timed out."});},5000);child.on("error",e=>{clearTimeout(timer);resolveStatus({available:false,inferenceValidated:false,license:"CC-BY-NC-4.0",modelPath,message:`SheetSage Python failed: ${e.message}`});});child.on("exit",()=>{clearTimeout(timer);try{resolveStatus(JSON.parse(out));}catch{resolveStatus({available:false,inferenceValidated:false,license:"CC-BY-NC-4.0",modelPath,message:"SheetSage status probe returned invalid output."});}});});
}
export async function engineStatus():Promise<EngineStatus>{const root=YUE_ROOT();let yue=false;try{await stat(join(root,"backend","generate.py"));await stat(join(root,".venv","bin","python"));yue=true;}catch{}return {yue:{available:yue,inferenceValidated:false,root,message:yue?"Local YuE2 MLX backend available (BF16 default; optional 4bit).":"Set WAVY_YUE_ROOT to a yue-local checkout with its isolated environment."},sheetsage:await sheetSageStatus()};}
export async function planComposition(input:BaseInput,signal?:AbortSignal,onProgress?:Progress){validate(input,"plan");await acquireLock(signal);try{const result=await runPython(join(HERE,"engine/yue.py"),{version:2,operation:"plan",...input,cot:input.settings.planning,precision:input.settings.precision},input.outputDir,signal,onProgress);if(typeof result.score!=="string"||!result.score.length||result.score.length>128_000)throw new Error("Engine returned invalid score");const rawPlanPath=await retainedFile(result.rawPlanPath,input.outputDir,"raw plan",1_000_000);finishReason(result.finishReason);finiteResult(result.elapsedSeconds,"elapsedSeconds");return {score:result.score,rawPlanPath,result};}finally{await releaseLock();}}
export async function renderComposition(input:BaseInput&{score?:string},signal?:AbortSignal,onProgress?:Progress){validate(input,"render",input.score);await acquireLock(signal);try{const s=input.settings;const semanticSampling={max_tokens:s.maxSemanticTokens,min_tokens:Math.min(200,s.maxSemanticTokens),...(s.temperature===undefined?{}:{temperature:s.temperature}),...(s.topP===undefined?{}:{top_p:s.topP}),...(s.topK===undefined?{}:{top_k:s.topK})};const result=await runPython(join(HERE,"engine/yue.py"),{version:2,operation:"render",...input,cot:input.score===undefined?"off":s.planning,precision:s.precision,cfgScale:s.cfgScale,steps:s.steps,semanticSampling},input.outputDir,signal,onProgress);const audioPath=await retainedFile(result.audioPath,input.outputDir,"audio",8_000_000_000);const wavPath=result.wavPath===undefined?undefined:await retainedFile(result.wavPath,input.outputDir,"WAV",8_000_000_000);const durationSeconds=finiteResult(result.durationSeconds,"durationSeconds");const elapsedSeconds=finiteResult(result.elapsedSeconds,"elapsedSeconds");const reason=finishReason(result.finishReason);if(typeof result.truncated!=="boolean"||(reason==="cap"&&!result.truncated)||(reason==="eos"&&result.truncated))throw new Error("Engine returned inconsistent truncation metadata");return {audioPath,wavPath,durationSeconds,elapsedSeconds,finishReason:reason,truncated:result.truncated,result};}finally{await releaseLock();}}
export async function transcribeSource(input:{audioPath:string;outputDir:string},signal?:AbortSignal,onProgress?:Progress){if(typeof input.audioPath!=="string"||!isAbsolute(input.audioPath)||typeof input.outputDir!=="string"||!isAbsolute(input.outputDir))throw new Error("audioPath and outputDir must be absolute paths");const python=process.env.WAVY_SHEETSAGE_PYTHON,model=process.env.WAVY_SHEETSAGE_MODEL;if(!python||!model)throw new Error("SheetSage2 unavailable: set WAVY_SHEETSAGE_PYTHON and WAVY_SHEETSAGE_MODEL (CC BY-NC 4.0); no install/download is performed.");const result=await runPython(join(HERE,"engine/sheetsage.py"),{operation:"transcribe",modelPath:model,...input},input.outputDir,signal,onProgress,python);return {score:result.score as string,events:result.events,result};}

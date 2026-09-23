import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engineStatus, planComposition, renderComposition, transcribeSource } from "../../engines.js";
import { DEFAULT_SETTINGS } from "../../types.js";

const oldSheet = process.env.WAVY_SHEETSAGE_PYTHON, oldRoot=process.env.WAVY_YUE_ROOT;
afterEach(() => { if (oldSheet === undefined) delete process.env.WAVY_SHEETSAGE_PYTHON; else process.env.WAVY_SHEETSAGE_PYTHON=oldSheet; if(oldRoot===undefined)delete process.env.WAVY_YUE_ROOT;else process.env.WAVY_YUE_ROOT=oldRoot; });
async function fakeRoot(mode:"success"|"sleep"|"stdout"|"outside"|"badmeta") {
  const root=await mkdtemp(join(tmpdir(),"wavy-engine-"));await mkdir(join(root,".venv/bin"),{recursive:true});await mkdir(join(root,"backend"));await writeFile(join(root,"backend/generate.py"),"");
  const exe=join(root,".venv/bin/python");await writeFile(exe,`#!/usr/bin/env node\nconst fs=require('fs'),{spawn}=require('child_process');const a=process.argv;const result=a[a.indexOf('--result')+1],request=JSON.parse(fs.readFileSync(a[a.indexOf('--request')+1]));const mode=${JSON.stringify(mode)};if(mode==='stdout')process.stdout.write('x'.repeat(2_000_000));if(mode==='sleep'){spawn('sleep',['30']);setTimeout(()=>{},30000);}else{const audio=mode==='outside'?'/tmp/wavy-evil-audio.wav':request.outputDir+'/audio.wav';fs.writeFileSync(audio,'audio');fs.writeFileSync(result,JSON.stringify({status:'completed',audioPath:audio,wavPath:audio,durationSeconds:mode==='badmeta'?'one':1,elapsedSeconds:1,truncated:true,finishReason:'cap'}));}\n`);await chmod(exe,0o755);return root;
}
const base={lyrics:"[Verse]\nHello",style:"indie pop",settings:{...DEFAULT_SETTINGS},seed:1,outputDir:"/tmp/wavy-test-never-run"};

describe("Wavy local engines",()=>{
  it("reports actionable backend status without loading models",async()=>{
    const status=await engineStatus();
    expect(status.yue.root).toBeTruthy();
    expect(status.sheetsage.available).toBe(false);
    expect(status.sheetsage.license).toMatch(/NC/);
  });
  it("rejects out-of-contract sampling controls",async()=>{
    await expect(planComposition({...base,settings:{...base.settings,topK:0}})).rejects.toThrow(/topK/);
  });
  it("requires planning for plan and score render",async()=>{
    await expect(planComposition({...base,settings:{...base.settings,planning:"off"}})).rejects.toThrow(/cannot produce/);
    await expect(renderComposition({...base,score:"X:1\nK:C\nC",settings:{...base.settings,planning:"off"}})).rejects.toThrow(/score requires/);
  });
  it("validates token cap and finite sampling deterministically",async()=>{
    await expect(renderComposition({...base,settings:{...base.settings,maxSemanticTokens:16385}})).rejects.toThrow(/maxSemanticTokens/);
    await expect(renderComposition({...base,settings:{...base.settings,temperature:NaN}})).rejects.toThrow(/temperature/);
  });
  it("gives an explicit SheetSage setup error",async()=>{
    delete process.env.WAVY_SHEETSAGE_PYTHON;
    await expect(transcribeSource({audioPath:"/tmp/a.wav",outputDir:"/tmp/o"})).rejects.toThrow(/WAVY_SHEETSAGE_PYTHON and WAVY_SHEETSAGE_MODEL/);
  });
  it("releases the OS lock after spawn errors and drains large stdout",async()=>{
    const bad=await mkdtemp(join(tmpdir(),"wavy-bad-"));process.env.WAVY_YUE_ROOT=bad;
    await expect(renderComposition({...base,outputDir:join(bad,"failed")})).rejects.toThrow();
    const root=await fakeRoot("stdout");process.env.WAVY_YUE_ROOT=root;
    await expect(renderComposition({...base,outputDir:join(root,"out")})).resolves.toMatchObject({finishReason:"cap"});
    expect((await readFile(join(root,"out/stdout.log"))).length).toBe(2_000_000);
    await rm(bad,{recursive:true,force:true});await rm(root,{recursive:true,force:true});
  },15_000);
  it("rejects backend paths outside the operation and malformed scalar metadata",async()=>{
    let root=await fakeRoot("outside");process.env.WAVY_YUE_ROOT=root;
    await expect(renderComposition({...base,outputDir:join(root,"out")})).rejects.toThrow(/outside outputDir/);await rm(root,{recursive:true,force:true});
    root=await fakeRoot("badmeta");process.env.WAVY_YUE_ROOT=root;
    await expect(renderComposition({...base,outputDir:join(root,"out")})).rejects.toThrow(/durationSeconds/);await rm(root,{recursive:true,force:true});
  });
  it("cancels while queued for the cross-process lock without starting",async()=>{
    const root=await fakeRoot("sleep");process.env.WAVY_YUE_ROOT=root;
    const firstAbort=new AbortController();const first=renderComposition({...base,outputDir:join(root,"first")},firstAbort.signal);
    await new Promise(r=>setTimeout(r,150));
    const queuedAbort=new AbortController();const queued=renderComposition({...base,outputDir:join(root,"queued")},queuedAbort.signal);
    queuedAbort.abort(new Error("queued cancelled"));await expect(queued).rejects.toThrow(/queued cancelled/);
    firstAbort.abort(new Error("running cancelled"));await expect(first).rejects.toThrow(/running cancelled/);
    expect(JSON.parse(await readFile(join(root,"first/result.json"),"utf8")).status).toBe("cancelled");
    await expect(readFile(join(root,"queued/request.json"))).rejects.toThrow();await rm(root,{recursive:true,force:true});
  },15_000);
});

import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { stlEnvironment, stlFloorFactor, stlViewingBounds, stlViewingRotation } from "../examples/pi-web-extensions/3d-modeling/stl-environment.js";
import { stlContribution } from "../examples/pi-web-extensions/3d-modeling/stl.js";

async function harness(size: number, gpuError = 0, legacy = false) {
  const result = await stlContribution(() => { throw Error("must not access file before consent"); }).render({ context: { name: "<mesh>.stl", path: "/api/artifacts/not-read.stl" } });
  expect(result).toHaveProperty("artifactBytes", true);
  const html = result.html;
  expect(html).toContain("&lt;mesh&gt;");
  expect(Buffer.byteLength(html)).toBeLessThan(1_000_000);
  const messages: any[] = [], uploads: Float32Array[] = [], drawn: number[] = [], deleted: number[] = [];
  const values: Record<string, any> = {}, events: Record<string, any> = {}, canvasEvents: Record<string, any> = {}, controls = new Map<string, any>();
  const listeners: ((event: any) => void)[] = []; let frame: (() => void) | undefined, bufferId = 0;
  const gl = new Proxy({ getShaderParameter: () => true, getProgramParameter: () => true, getError: () => gpuError, isContextLost: () => false, NO_ERROR: 0,
    getUniformLocation: (_: any, name: string) => name, getUniform: (_: any, name: string) => values[name],
    uniformMatrix3fv: (name: string, _: boolean, value: Float32Array) => {values[name]=[...value];if(name==="r")(values.rCalls??=[]).push([...value]);}, uniform3f: (name: string,...value:number[])=>{values[name]=value;},
    uniform2fv: (name: string, value: number[]) => {values[name] = [...value];}, uniform1f: (name: string, value: number) => {values[name] = value;},
    createBuffer: () => ++bufferId, deleteBuffer: (id: number) => deleted.push(id), getExtension: () => null,
    drawArrays: (_: any, __: any, count: number) => drawn.push(count),
    bufferData: (_: any, data: Float32Array) => uploads.push(new Float32Array(data)) }, { get(target, key) { return (target as any)[key] ?? (() => 1); } });
  const canvas = { getContext: () => gl, addEventListener(name: string, fn: any) {canvasEvents[name] = fn;}, clientWidth: 600, clientHeight: 400, focus() {}, setPointerCapture() {} } as any;
  const status = { textContent: "" };
  const parent = {};
  const port = { close() {}, postMessage: (m: any) => messages.push(m), onmessage: undefined as any };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1], { requestAnimationFrame: (fn: () => void) => {frame = fn;}, document: { addEventListener() {}, querySelectorAll: () => [], querySelector: (s: string) => {if(s === "canvas") return canvas;if(s === "#status") return status;if(!controls.has(s)) controls.set(s,{value:s === '#material' ? 'ivory' : 'studio',checked:false,setAttribute() {}});return controls.get(s);} }, window: { addEventListener: (name: string, fn: any) => { events[name] = fn; if(name === "message") listeners.push(fn); } }, parent, devicePixelRatio: 1, ResizeObserver: class { observe() {} }, TextDecoder, Float32Array, Uint8Array, DataView, ArrayBuffer, performance });
  const dispatch = (data: any, ports: any[] = []) => { for(const listener of listeners)listener({source:parent,data,ports}); };
  dispatch({ type: "pi-artifact-stream", size, streamVersion: legacy ? 1 : 2 }, [port]);
  let nextChunk = 0;
  return { dispatch, send: (data: any) => port.onmessage({ data: data.type === "chunk" ? {id:nextChunk++, ...data} : data }), messages, uploads, status, canvas, values, drawn, deleted, events, canvasEvents, controls, draw: () => { const fn = frame; frame = undefined; fn?.(); } };
}
function binary(triangles: number) {
  const b = Buffer.alloc(84 + triangles * 50); b.writeUInt32LE(triangles, 80);
  for (let i = 0; i < triangles; i++) for (let k = 0; k < 9; k++) b.writeFloatLE([0,0,0,1,0,0,0,1,0][k] + i * .000001, 84 + i * 50 + 12 + k * 4);
  return b;
}
describe("full-detail STL stream", () => {
  it("keeps every binary triangle and coordinate across arbitrary chunk boundaries", async () => {
    const b = binary(8200), h = await harness(b.length);
    for (let offset = 0; offset < b.length; offset += 777) h.send({ type: "chunk", bytes: Uint8Array.from(b.subarray(offset, offset + 777)).buffer });
    h.send({ type: "end" });
    expect(h.messages.at(-1)).toMatchObject({ type: "complete", triangles: 8200 });
    expect(h.uploads.slice(0,2).map(x => x.length / 18)).toEqual([8192, 8]);
    const first = h.uploads[0];
    expect(Array.from(first.slice(0, 3))).toEqual([0,0,0]);
    expect(Array.from(first.slice(6, 9))).toEqual([1,0,0]);
    expect(h.status.textContent).toContain("Full detail · 8,200 triangles");
    h.draw(); expect(h.drawn).toEqual([8192 * 3, 8 * 3, 8192 * 3, 8 * 3]);
    h.events.pagehide(); expect(h.deleted).toHaveLength(10);
  });
  it("handles ASCII without a final newline", async () => {
    const b = Buffer.from("solid a\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0");
    const h = await harness(b.length);
    for (const byte of b) h.send({ type: "chunk", bytes: Uint8Array.of(byte).buffer });
    h.send({ type: "end" });
    expect(h.messages.at(-1)).toMatchObject({ type: "complete", triangles: 1 });
  });
  it("fails visibly rather than silently dropping non-finite triangles", async () => {
    const b = binary(1); b.writeFloatLE(NaN, 96); const h = await harness(b.length);
    h.send({ type: "chunk", bytes: Uint8Array.from(b).buffer });
    expect(h.messages.at(-1).type).toBe("error");
    expect(h.status.textContent).toContain("non-finite");
  });
  it("supports keyboard and two-pointer navigation, fit recovery and pointer cancellation without mesh reupload", async () => {
    const b = binary(1), h = await harness(b.length); h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});h.draw();
    const initial = {...h.values}, uploads = h.uploads.length;
    const key = (key: string, shiftKey = false) => h.canvas.onkeydown({key,shiftKey,preventDefault() {}});
    key('ArrowRight');key('+');h.draw();expect(h.values.r).not.toEqual(initial.r);expect(h.values.scale).toBeGreaterThan(initial.scale);
    key('ArrowLeft',true);h.draw();expect(h.values.pan).not.toEqual(initial.pan);
    key('f');h.draw();expect(h.values.pan).toEqual(initial.pan);expect(h.values.scale).toBeGreaterThan(0);
    h.canvas.onpointerdown({pointerId:1,clientX:100,clientY:100});h.canvas.onpointerdown({pointerId:2,clientX:200,clientY:100});
    h.canvas.onpointermove({pointerId:2,clientX:250,clientY:120});h.draw();expect(h.values.scale).toBeGreaterThan(initial.scale);
    h.canvas.onpointercancel({pointerId:1});h.canvas.onlostpointercapture({pointerId:2});
    const lastScale=h.values.scale;h.canvas.onpointermove({pointerId:2,clientX:500,clientY:500});h.draw();expect(h.values.scale).toBe(lastScale);
    expect(h.uploads).toHaveLength(uploads);
  });
  it("reports context loss as an error and deletes uploaded mesh buffers", async () => {
    const b=binary(1),h=await harness(b.length);h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});
    h.canvasEvents.webglcontextlost({preventDefault() {}});expect(h.messages.at(-1)).toMatchObject({type:'error'});expect(h.status.textContent).toContain('GPU context lost');expect(h.deleted).toHaveLength(9);
  });
  it("accepts legacy hosts without IDs or the v2 chunk-size contract", async () => {
    const b=binary(22000),h=await harness(b.length,0,true);
    expect(h.messages[0]).toMatchObject({type:'ready',streamVersion:1});
    h.send({type:'chunk',id:undefined,bytes:Uint8Array.from(b).buffer});h.send({type:'end'});
    expect(h.messages.at(-1)).toMatchObject({type:'complete',triangles:22000});
  });
  it("rejects oversized and out-of-order chunks before decoding", async () => {
    for (const data of [{id:1,bytes:new ArrayBuffer(1)}, {id:0,bytes:new ArrayBuffer(1024*1024+1)}]) {
      const h=await harness(100);
      h.send({type:'chunk',...data});
      expect(h.messages.at(-1)).toMatchObject({type:'error'});
      expect(h.status.textContent).toContain('Invalid source chunk');
      expect(h.uploads).toHaveLength(0);
    }
  });
  it("fails visibly on GPU allocation errors without reporting completion", async () => {
    const b=binary(1),h=await harness(b.length,1285);
    h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});
    expect(h.messages.at(-1)).toMatchObject({type:'error'});
    expect(h.status.textContent).toContain('GPU memory allocation failed');
  });
  it("rejects truncated models", async () => {
    const b = binary(1), h = await harness(b.length);
    h.send({ type: "chunk", bytes: Uint8Array.from(b.subarray(0, 100)).buffer }); h.send({ type: "end" });
    expect(h.messages.at(-1).type).toBe("error");
  });
});

describe('true feature edge stream',()=>{
  it('generates only on opt-in, uploads every line, toggles visibility without mesh reupload and keeps model usable on edge failure',async()=>{
    const b=binary(1),h=await harness(b.length);h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});h.draw();
    expect(h.messages.some(m=>m.type==='derive')).toBe(false);const toggle=h.controls.get('#outlines');toggle.checked=true;toggle.onchange();expect(h.messages.at(-1)).toEqual({type:'derive'});
    const messages:any[]=[];const port={postMessage:(m:any)=>messages.push(m),close(){},onmessage:undefined as any};
    h.dispatch({type:'pi-artifact-derived',size:48,streamVersion:2},[port]);expect(messages.at(-1)).toEqual({type:'ready',streamVersion:2});
    const lines=new Float32Array([0,0,0,1,0,0,0,1,0,1,1,0]);const bytes=new Uint8Array(lines.buffer);port.onmessage({data:{type:'chunk',id:0,bytes:bytes.slice(0,13).buffer}});port.onmessage({data:{type:'chunk',id:1,bytes:bytes.slice(13).buffer}});port.onmessage({data:{type:'end'}});h.draw();
    expect(messages.at(-1)).toEqual({type:'complete'});expect(h.controls.get('#edge-status').textContent).toContain('2 true feature edges');expect(h.drawn.at(-1)).toBe(4);
    const uploads=h.uploads.length;toggle.checked=false;toggle.onchange();h.draw();toggle.checked=true;toggle.onchange();h.draw();expect(h.uploads.length).toBe(uploads);expect(h.messages.filter(m=>m.type==='derive')).toHaveLength(1);
    h.send({type:'derive-error',error:'Scratch quota exceeded'});h.draw();expect(h.status.textContent).toContain('Full detail');expect(h.controls.get('#edge-status').textContent).toContain('Scratch quota');expect(toggle.checked).toBe(false);expect(h.messages.some(m=>m.type==='error')).toBe(false);
  });
  it('cancels optional edge work without cancelling or reloading the source mesh',async()=>{const b=binary(1),h=await harness(b.length);h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});const toggle=h.controls.get('#outlines');toggle.checked=true;toggle.onchange();toggle.checked=false;toggle.onchange();expect(h.messages.at(-1)).toEqual({type:'derive-cancel'});h.draw();expect(h.status.textContent).toContain('Full detail');});
});

describe("PR277 scene contract", () => {
  it("retains the original bounded Y-up floor, radial fades, shadow and box", () => {
    const e=stlEnvironment([0,0,0,10,20,30]);
    expect(e.floorY).toBe(-30*.018);
    expect(e.ground).toHaveLength(96*9);expect(e.groundAlpha.slice(0,3)).toEqual([1,0,0]);
    expect(e.grid).toHaveLength(15*32*2*2*3);expect(e.box).toHaveLength(24*3);
    expect(e.ground.slice(0,6)).toEqual([5,e.floorY,15,5+30*.95*1.5,e.floorY,15]);
    expect(e.shadow[1]).toBe(e.floorY+30*.0006);expect(e.grid[1]).toBe(e.floorY+30*.0003);
    expect(stlFloorFactor(Math.sin(-.58))).toBe(1);expect(stlFloorFactor(0)).toBe(0);expect(stlFloorFactor(.5)).toBe(0);
    expect(stlFloorFactor(-.11)).toBe(.5);
  });
  it("retains default view, uses viewport-safe fit and grab-model drag without orbit clamps", async()=>{
    const b=binary(1),h=await harness(b.length);h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});h.draw();
    const matrix=(a:number,b:number)=>[Math.cos(b),Math.sin(a)*Math.sin(b),-Math.cos(a)*Math.sin(b),0,Math.cos(a),Math.sin(a),Math.sin(b),-Math.sin(a)*Math.cos(b),Math.cos(a)*Math.cos(b)].map(Math.fround);
    expect(h.values.r).toEqual(matrix(-.58,2.4));expect(h.values.scale).toBeCloseTo(1.55/Math.sqrt(2));
    h.canvas.onpointerdown({pointerId:1,clientX:10,clientY:10,pointerType:'mouse',button:0});
    h.canvas.onpointermove({pointerId:1,clientX:110,clientY:210});h.draw();expect(h.values.r).toEqual(matrix(-.58-200*.009,2.4-100*.009));
    h.controls.get('#reset').onclick();h.draw();expect(h.values.r).toEqual(matrix(-.58,2.4));
    const fitted={r:[...h.values.r],pan:[...h.values.pan],scale:h.values.scale};
    h.canvas.onkeydown({key:'ArrowRight',preventDefault(){}});h.canvas.onkeydown({key:'ArrowUp',shiftKey:true,preventDefault(){}});h.canvas.onkeydown({key:'+',preventDefault(){}});h.draw();
    expect(h.values.r).not.toEqual(fitted.r);expect(h.values.pan).not.toEqual(fitted.pan);expect(h.values.scale).not.toBe(fitted.scale);
    h.canvas.onkeydown({key:'f',preventDefault(){}});h.draw();expect(h.values.r).toEqual(fitted.r);expect(h.values.pan).toEqual(fitted.pan);expect(h.values.scale).toBe(fitted.scale);
    for(const [w,height] of [[393,818],[760,818],[1400,400]]) {
      h.canvas.clientWidth=w;h.canvas.clientHeight=height;h.controls.get('#reset').onclick();h.draw();
      const r=h.values.r,scale=h.values.scale,center=h.values.center;
      for(const p of [[0,0,0],[1,0,0],[0,1,0],[1,1,0]]) {
        const v=p.map((x,i)=>x-center[i]);
        const x=(r[0]*v[0]+r[3]*v[1]+r[6]*v[2])*scale/(w/height);
        const y=(r[1]*v[0]+r[4]*v[1]+r[7]*v[2])*scale;
        expect(Math.abs(x)).toBeLessThan(.78);expect(Math.abs(y)).toBeLessThan(.78);
      }
    }
  });
});

it("uses one explicit right-handed basis for Z-up bounds, mesh positions and normals without mesh reupload",async()=>{
  expect(stlViewingBounds([1,2,3,4,5,6],true)).toEqual([1,3,-5,4,6,-2]);
  const identity=[1,0,0,0,1,0,0,0,1],basis=stlViewingRotation(identity,true);
  const apply=(v:number[])=>[0,1,2].map(i=>basis[i]*v[0]+basis[i+3]*v[1]+basis[i+6]*v[2]);
  expect(apply([0,0,1])).toEqual([0,1,0]);expect(apply([0,1,0])).toEqual([0,0,-1]);
  expect(stlViewingRotation(identity,false)).toEqual(identity);
  const b=binary(8200),h=await harness(b.length);h.send({type:'chunk',bytes:Uint8Array.from(b).buffer});h.send({type:'end'});h.draw();
  const matrix=h.values.r,first=h.uploads[0],uploads=h.uploads.length;
  h.controls.get('#up-axis').value='z';h.controls.get('#up-axis').onchange();h.draw();
  expect(h.values.rCalls.at(-3)).toEqual(stlViewingRotation(matrix,true));expect(h.uploads.length-uploads).toBe(8);expect(h.uploads[0]).toBe(first);
});

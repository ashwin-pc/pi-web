import { readFile } from "node:fs/promises";
import { artifactFile, errorView, esc } from "./shared.js";

const KEY = "stl-viewer.preview";
const MAX_HTML = 990_000;
type Triangle = [number, number, number, number, number, number, number, number, number];
type Model = { positions: Float32Array; normals: Float32Array; indices: Uint16Array | Uint32Array; sourceTriangles: number; bounds: [number, number, number, number, number, number] };

function triangles(buffer: Buffer): Triangle[] {
  const count = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
  const binary = count > 0 && 84 + count * 50 <= buffer.length;
  const out: Triangle[] = [];
  if (binary) {
    for (let i = 0, o = 84; i < count && o + 50 <= buffer.length; i++, o += 50) {
      const t: number[] = [];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) t.push(buffer.readFloatLE(o + 12 + v * 12 + k * 4));
      if (t.every(Number.isFinite)) out.push(t as Triangle);
    }
  } else {
    const vs = Array.from(buffer.toString("utf8").matchAll(/\bvertex\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)/gi), m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (let i = 0; i + 2 < vs.length; i += 3) { const t = [...vs[i], ...vs[i + 1], ...vs[i + 2]]; if (t.every(Number.isFinite)) out.push(t as Triangle); }
  }
  if (!out.length) throw new Error("No triangles were found in this STL.");
  return out;
}

// Vertex clustering is only used when the packed, fully indexed mesh cannot fit the
// preview response. Unlike face sampling, it remaps the complete mesh and removes
// only faces collapsed by an edge contraction, so the displayed surface stays joined.
function indexMesh(source: Triangle[], cellScale = 1e-7): Model {
  const bounds: Model["bounds"] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const t of source) for (let i = 0; i < 9; i += 3) for (let k = 0; k < 3; k++) { bounds[k] = Math.min(bounds[k], t[i + k]); bounds[k + 3] = Math.max(bounds[k + 3], t[i + k]); }
  const span = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2], 1);
  const cell = Math.max(span * cellScale, Number.EPSILON * span * 32), map = new Map<string, number>(), p: number[] = [], ix: number[] = [];
  for (const t of source) {
    const face: number[] = [];
    for (let i = 0; i < 9; i += 3) {
      const key = `${Math.round((t[i] - bounds[0]) / cell)},${Math.round((t[i + 1] - bounds[1]) / cell)},${Math.round((t[i + 2] - bounds[2]) / cell)}`;
      let n = map.get(key); if (n === undefined) { n = p.length / 3; map.set(key, n); p.push(t[i], t[i + 1], t[i + 2]); } face.push(n);
    }
    if (face[0] !== face[1] && face[1] !== face[2] && face[2] !== face[0]) ix.push(...face);
  }
  const normals = new Float32Array(p.length);
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) { const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1; normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l; }
  // STL exporters frequently reverse every face. Orient the mesh globally using
  // its bounds center while still rendering both sides for locally mixed files.
  const center = [(bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2];
  let orientation = 0;
  for (let i = 0; i < normals.length; i += 3) orientation += normals[i] * (p[i] - center[0]) + normals[i + 1] * (p[i + 1] - center[1]) + normals[i + 2] * (p[i + 2] - center[2]);
  if (orientation < 0) for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  const indices = p.length / 3 <= 65535 ? new Uint16Array(ix) : new Uint32Array(ix);
  return { positions: new Float32Array(p), normals, indices, sourceTriangles: source.length, bounds };
}
function b64(a: ArrayBufferView) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64"); }
function packed(m: Model) { return { p: b64(m.positions), n: b64(m.normals), i: b64(m.indices), u: m.indices.BYTES_PER_ELEMENT === 4 ? 32 : 16, s: m.sourceTriangles, d: m.indices.length / 3, b: m.bounds }; }

function viewer(name: string, source: Triangle[]) {
  let scale = 1e-7, model = indexMesh(source, scale), data = JSON.stringify(packed(model));
  while (data.length > MAX_HTML - 12_000 && scale < .1) { scale *= 1.7; model = indexMesh(source, scale); data = JSON.stringify(packed(model)); }
  if (data.length > MAX_HTML - 12_000) throw new Error("This mesh cannot be compacted safely enough for the preview response.");
  const size = model.bounds.slice(3).map((v, i) => v - model.bounds[i]);
  return { html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="color-scheme" content="dark"><style>*{box-sizing:border-box}html,body,.stage{height:100%;margin:0;overflow:hidden;overscroll-behavior:none}body{background:#080d18;color:#dce7fa;font:13px system-ui}.stage{position:relative;min-height:360px;background:radial-gradient(circle at 50% 42%,#24334d,#080d18 72%)}canvas{width:100%;height:100%;display:block;touch-action:none;cursor:grab}.title{position:absolute;left:14px;top:12px;max-width:calc(100% - 70px);padding:7px 10px;border:1px solid #30405d;border-radius:9px;background:#0c1422dd;color:white;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.info{position:absolute;right:14px;top:12px}.info>button{width:34px;height:34px;border:1px solid #40516e;border-radius:50%;background:#111b2cdd;color:white;font:bold 15px Georgia;cursor:pointer}.tip{position:absolute;right:0;top:42px;width:245px;padding:13px;border:1px solid #354662;border-radius:11px;background:#101827f2;opacity:0;visibility:hidden}.info.open .tip{opacity:1;visibility:visible}.tip div{padding:5px 0;color:#91a1ba}.tip b{float:right;color:white}.tip button{width:100%;margin-top:8px;padding:7px;border:1px solid #354662;border-radius:7px;background:#18243a;color:white}.hint{position:absolute;left:14px;bottom:11px;padding:5px 8px;border-radius:7px;background:#0a111dcc;color:#8190a9;font-size:12px;pointer-events:none}</style></head><body><div class="stage"><canvas aria-label="Interactive 3D STL model"></canvas><div class="title">${esc(name)}</div><div class="info"><button id="info" aria-label="Model information">i</button><div class="tip"><div>Dimensions <b>${size.map(n => n.toFixed(1)).join(" × ")} mm</b></div><div>Triangles <b>${model.indices.length / 3 === model.sourceTriangles ? model.sourceTriangles.toLocaleString() : `${(model.indices.length / 3).toLocaleString()} / ${model.sourceTriangles.toLocaleString()}`}</b></div><div>Rendering <b>Indexed WebGL</b></div><button id="reset">Reset view</button></div></div><div class="hint">Orbit · shift/right-drag pan · wheel/pinch zoom</div></div><script>const M=${data},c=document.querySelector('canvas'),gl=c.getContext('webgl2',{antialias:true}),info=document.querySelector('.info');if(!gl)throw Error('WebGL 2 is required');function bytes(s){const q=atob(s),a=new Uint8Array(q.length);for(let i=0;i<q.length;i++)a[i]=q.charCodeAt(i);return a.buffer}const P=new Float32Array(bytes(M.p)),N=new Float32Array(bytes(M.n)),I=M.u===16?new Uint16Array(bytes(M.i)):new Uint32Array(bytes(M.i));function sh(t,s){const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(x));return x}const pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,'#version 300 es\\nin vec3 p,n;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out vec3 normal;void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);normal=r*n;}'));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,'#version 300 es\\nprecision mediump float;in vec3 normal;out vec4 color;void main(){float d=abs(dot(normalize(normal),normalize(vec3(.35,.55,.8))));color=vec4(vec3(.10,.64,.82)*(.58+.42*d),1);}'));gl.linkProgram(pr);gl.useProgram(pr);for(const [key,a]of [['p',P],['n',N]]){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,a,gl.STATIC_DRAW);const l=gl.getAttribLocation(pr,key);gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,3,gl.FLOAT,false,0,0)}const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,I,gl.STATIC_DRAW);const B=M.b,center=new Float32Array([(B[0]+B[3])/2,(B[1]+B[4])/2,(B[2]+B[5])/2]),span=Math.max(B[3]-B[0],B[4]-B[1],B[5]-B[2])||1;gl.uniform3fv(gl.getUniformLocation(pr,'center'),center);gl.enable(gl.DEPTH_TEST);/* STL winding is not reliably consistent; render both sides. */let ax=-.58,ay=2.4,z=1,ox=0,oy=0,pts=new Map,gesture,mode='orbit';function draw(){const d=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*d;c.height=h*d;gl.viewport(0,0,c.width,c.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);const x=Math.cos(ax),X=Math.sin(ax),y=Math.cos(ay),Y=Math.sin(ay);gl.uniformMatrix3fv(gl.getUniformLocation(pr,'r'),false,new Float32Array([y,X*Y,-x*Y,0,x,X,Y,-X*y,x*y]));gl.uniform1f(gl.getUniformLocation(pr,'scale'),1.55*z/span);gl.uniform1f(gl.getUniformLocation(pr,'aspect'),w/h);gl.uniform2f(gl.getUniformLocation(pr,'pan'),ox/w*2,-oy/h*2);gl.drawElements(gl.TRIANGLES,I.length,M.u===16?gl.UNSIGNED_SHORT:gl.UNSIGNED_INT,0)}function pair(){const a=[...pts.values()];return a.length<2?null:{x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2,d:Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y)}}c.oncontextmenu=e=>e.preventDefault();c.onpointerdown=e=>{e.preventDefault();c.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});mode=e.pointerType==='mouse'&&(e.button||e.shiftKey)?'pan':'orbit';gesture=pair()};c.onpointermove=e=>{if(!pts.has(e.pointerId))return;const old=pts.get(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pts.size>1){const q=pair();if(gesture){z=Math.max(.15,Math.min(10,z*q.d/(gesture.d||q.d)));ox+=q.x-gesture.x;oy+=q.y-gesture.y}gesture=q}else if(mode==='pan'){ox+=e.clientX-old.x;oy+=e.clientY-old.y}else{ay+=(e.clientX-old.x)*.009;ax+=(e.clientY-old.y)*.009}draw()};function up(e){pts.delete(e.pointerId);gesture=pair()}c.onpointerup=c.onpointercancel=up;c.onwheel=e=>{e.preventDefault();z=Math.max(.15,Math.min(10,z*Math.exp(-e.deltaY*.001)));draw()};const button=document.querySelector('#info');button.onclick=()=>info.classList.toggle('open');document.querySelector('#reset').onclick=()=>{ax=-.58;ay=2.4;z=1;ox=oy=0;draw()};new ResizeObserver(draw).observe(c);draw()</script></body></html>` };
}
export function stlContribution(getCwd: () => string) {
  return { slot: "artifact-preview", kind: "rendered", title: "STL viewer", label: "3D mesh", match: { extensions: [".stl"] }, async render(event: any) {
    try { const context = event?.context; if (!context || typeof context.path !== "string") return errorView("Cannot open STL", "The artifact context is missing."); const file = await artifactFile(getCwd(), context.path, 20 * 1024 * 1024, "STL", 20); return viewer(typeof context.name === "string" ? context.name : "STL model", triangles(await readFile(file))); }
    catch (error) { return errorView("Cannot open STL", error instanceof Error ? error.message : String(error)); }
  }};
}

(() => {
  const canvas = document.querySelector('canvas'), status = document.querySelector('#status');
  const gl = canvas.getContext('webgl2', { antialias: true });
  let port, ended = false;
  const buffers = [], edgeBuffers = [];
  const edgeToggle = document.querySelector('#outlines'), edgeStatus = document.querySelector('#edge-status');
  let edgePort, edgeReady = false, edgeLoading = false;
  const clearEdges = () => { for(const entry of edgeBuffers)gl.deleteBuffer(entry.buffer);edgeBuffers.length=0;edgeReady=false;edgePort?.close();edgePort=null; };
  const edgeFailure = message => { clearEdges();edgeLoading=false;edgeToggle.checked=false;edgeToggle.setAttribute('aria-busy','false');edgeStatus.textContent=message;render(); };
  let failed = false, scheduled = false;
  const error = e => { if (failed) return; failed = true; clearEdges(); port?.postMessage({type:'derive-cancel'}); status.textContent = e.message || String(e); document.querySelector('#waiting').hidden = true; for (const entry of buffers) gl.deleteBuffer(entry.buffer); buffers.length = 0; for(const mesh of [box,ground,grid,shadow])if(mesh){gl.deleteBuffer(mesh.p);gl.deleteBuffer(mesh.a);} box=ground=grid=shadow=null; port?.postMessage({ type: 'error', error: status.textContent }); };
  if (!gl) { window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='pi-artifact-stream'&&event.ports.length===1)event.ports[0].postMessage({type:'error',error:'WebGL 2 is unavailable. Enable browser hardware acceleration or download the original for a desktop viewer.'});}); return; }
  const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s)); return s; };
  let program;
  try {
  program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, "#version 300 es\nin vec3 p,n;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out vec3 normal;void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);normal=r*n;}"));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "#version 300 es\nprecision mediump float;in vec3 normal;uniform bool line;uniform float alpha;out vec4 color;void main(){if(line){color=vec4(.015,.015,.015,1);return;}float d=abs(dot(normalize(normal),normalize(vec3(.35,.55,.8))));vec3 base=vec3(.68);color=vec4(base*(.58+.42*d),alpha);}"));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  } catch (_) {
    window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='pi-artifact-stream'&&event.ports.length===1)event.ports[0].postMessage({type:'error',error:'The graphics renderer could not initialize. Update your browser or graphics driver, or download the original for a desktop viewer.'});});return;
  }
  const p = gl.getAttribLocation(program, 'p'), n = gl.getAttribLocation(program, 'n');
  const uniforms = Object.fromEntries(['r','center','scale','aspect','pan','line','alpha'].map(k => [k,gl.getUniformLocation(program,k)]));
  const bounds = [Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  let batch = new Float32Array(8192 * 18), used = 0, count = 0, bytes = 0, expected = 0, binary, pending = new Uint8Array(0), text = '', vertices = [], angle = [-.58,2.4], pan = [0,0], zoom = 1;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decodeMs = 0, uploadMs = 0;
  const upload = () => {
    if (!used) return;
    const uploadStart = performance.now();
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, batch.subarray(0,used), gl.STATIC_DRAW);
    const failure = gl.getError(); if (failure !== gl.NO_ERROR) throw Error('GPU memory allocation failed; close the model or use a larger-memory device.');
    buffers.push({ buffer, count: used / 6 }); used = 0;
    uploadMs += performance.now() - uploadStart;
  };
  // Scalar binary path: no vertex/normal arrays or spread calls per triangle.
  const triangle = (ax,ay,az,bx,by,bz,cx,cy,cz) => {
    if (!Number.isFinite(ax)||!Number.isFinite(ay)||!Number.isFinite(az)||!Number.isFinite(bx)||!Number.isFinite(by)||!Number.isFinite(bz)||!Number.isFinite(cx)||!Number.isFinite(cy)||!Number.isFinite(cz)) throw Error('STL contains non-finite vertex coordinates; no triangles were silently removed.');
    const ux=bx-ax,uy=by-ay,uz=bz-az,vx=cx-ax,vy=cy-ay,vz=cz-az;
    let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    // Preserve the original flat shader input: unnormalised face cross product.
    bounds[0]=Math.min(bounds[0],ax,bx,cx);bounds[1]=Math.min(bounds[1],ay,by,cy);bounds[2]=Math.min(bounds[2],az,bz,cz);
    bounds[3]=Math.max(bounds[3],ax,bx,cx);bounds[4]=Math.max(bounds[4],ay,by,cy);bounds[5]=Math.max(bounds[5],az,bz,cz);
    batch[used++]=ax;batch[used++]=ay;batch[used++]=az;batch[used++]=nx;batch[used++]=ny;batch[used++]=nz;
    batch[used++]=bx;batch[used++]=by;batch[used++]=bz;batch[used++]=nx;batch[used++]=ny;batch[used++]=nz;
    batch[used++]=cx;batch[used++]=cy;batch[used++]=cz;batch[used++]=nx;batch[used++]=ny;batch[used++]=nz;
    count++; if(used===batch.length) upload();
  };
  const parseBinary = data => {
    const view = new DataView(data.buffer,data.byteOffset,data.byteLength);
    let offset=0;
    for(;offset+50<=data.length;offset+=50) {
      if(count>=expected) throw Error('STL has unexpected trailing triangle data.');
      const p=offset+12;
      triangle(view.getFloat32(p,true),view.getFloat32(p+4,true),view.getFloat32(p+8,true),view.getFloat32(p+12,true),view.getFloat32(p+16,true),view.getFloat32(p+20,true),view.getFloat32(p+24,true),view.getFloat32(p+28,true),view.getFloat32(p+32,true));
    }
    pending=data.slice(offset);
  };
  const parseAscii = (data, final=false) => {
    text+=decoder.decode(data,{stream:!final});
    const lines=text.split(/\r?\n/); text=final?'':lines.pop();
    for(const line of lines) {
      if(line.length>65536) throw Error('Invalid STL line length.');
      if(/^\s*vertex\b/i.test(line)) {
        const m=/^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/i.exec(line); if(!m) throw Error('Malformed ASCII STL vertex.');
        vertices.push(Number(m[1]),Number(m[2]),Number(m[3])); if(vertices.length===9) { triangle(...vertices); vertices=[]; }
      }
    }
    if(text.length>65536) throw Error('Invalid STL line length.');
  };
  const consume = data => {
    bytes+=data.length;
    if(binary===undefined || binary) {
      const joined=new Uint8Array(pending.length+data.length); joined.set(pending); joined.set(data,pending.length); pending=joined;
      if(binary===undefined && pending.length>=84) {
        expected=new DataView(pending.buffer).getUint32(80,true);
        binary=84+expected*50===size;
        const first=pending; pending=new Uint8Array(0);
        if(binary) parseBinary(first.subarray(84)); else parseAscii(first);
      } else if(binary) parseBinary(joined);
    } else parseAscii(data);
    status.textContent=`${count.toLocaleString()} triangles decoded · ${(bytes/size*100).toFixed(0)}% received`;
  };
  function environmentBuffer(a){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,a,gl.STATIC_DRAW);return b;}
let environmentGeometry, environmentCamera;
const viewingBounds=__VIEWING_BOUNDS__, viewingRotation=__VIEWING_ROTATION__;
const isZUp=()=>document.querySelector("#up-axis").value==="z";
const floorFactor = __FLOOR_FACTOR__;
const boundsToggle = document.querySelector("#bounds");
const envProgram = gl.createProgram();
gl.attachShader(
  envProgram,
  shader(
    gl.VERTEX_SHADER,
    `#version 300 es
in vec3 p;in float a;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out float fade;
void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);fade=a;}`,
  ),
);
gl.attachShader(
  envProgram,
  shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
precision mediump float;uniform vec4 ink;in float fade;out vec4 color;
void main(){color=vec4(ink.rgb,ink.a*fade);}`,
  ),
);
gl.linkProgram(envProgram);
function layer(p, a) {
  return {
    p: environmentBuffer(new Float32Array(p)),
    a: environmentBuffer(new Float32Array(a || Array(p.length / 3).fill(1))),
    count: p.length / 3,
  };
}
let ground, grid, shadow, box;
const makeFloor = () => {
 for(const mesh of [ground,grid,shadow,box])if(mesh){gl.deleteBuffer(mesh.p);gl.deleteBuffer(mesh.a);}
 environmentGeometry = __ENVIRONMENT__(viewingBounds(bounds,isZUp()));
 ground=layer(environmentGeometry.ground,environmentGeometry.groundAlpha);
 grid=layer(environmentGeometry.grid,environmentGeometry.gridAlpha);
 shadow=layer(environmentGeometry.shadow,environmentGeometry.shadowAlpha);
 box=layer(environmentGeometry.box);
};
function environment(factor, drawBox = false) {
  gl.useProgram(envProgram);
  for (const key of ["r", "center", "scale", "aspect", "pan"]) {
    const value = key === "r" ? environmentCamera.r : key === "center" ? environmentCamera.center : gl.getUniform(program, gl.getUniformLocation(program, key)),
      loc = gl.getUniformLocation(envProgram, key);
    if (key === "r") gl.uniformMatrix3fv(loc, false, value);
    else if (key === "center") gl.uniform3fv(loc, value);
    else if (key === "pan") gl.uniform2fv(loc, value);
    else gl.uniform1f(loc, value);
  }
  function paint(mesh, ink, primitive) {
    for (const [key, b, size] of [
      ["p", mesh.p, 3],
      ["a", mesh.a, 1],
    ]) {
      const loc = gl.getAttribLocation(envProgram, key);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    gl.uniform4fv(gl.getUniformLocation(envProgram, "ink"), ink);
    gl.drawArrays(primitive, 0, mesh.count);
  }
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  // The entire floor is a composited backdrop, NEVER an occluder.
  gl.depthMask(false);
  if (drawBox) {
    if (boundsToggle.checked) paint(box, [0.76, 0.69, 0.55, 0.2], gl.LINES);
  } else if (factor > 0 && document.querySelector("#ground").checked) {
    paint(ground, [0.13, 0.13, 0.125, 0.94 * factor], gl.TRIANGLES);
    if(document.querySelector("#grid").checked) paint(grid, [0.62, 0.62, 0.59, 0.27 * factor], gl.LINES);
    paint(shadow, [0, 0, 0, 0.47 * factor], gl.TRIANGLES);
  }
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.useProgram(program);
}

  const markView = (view) => { for(const button of document.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===view)); };
  const fit = () => {pan=[0,0];zoom=1;};
  const resetView = () => {angle=[-.58,2.4];fit();markView('iso');};
  const draw = () => {
    scheduled=false;if(!ended||failed)return;
    const d=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;
    canvas.width=w*d;canvas.height=h*d;gl.viewport(0,0,canvas.width,canvas.height);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.useProgram(program);
    const x=Math.cos(angle[0]),X=Math.sin(angle[0]),y=Math.cos(angle[1]),Y=Math.sin(angle[1]);
    const r=[y,X*Y,-x*Y,0,x,X,Y,-X*y,x*y], b=viewingBounds(bounds,isZUp());
    environmentCamera={r:new Float32Array(r),center:new Float32Array([0,1,2].map(k=>(b[k]+b[k+3])/2))};
    gl.uniformMatrix3fv(uniforms.r,false,new Float32Array(viewingRotation(r,isZUp())));
    gl.uniform3f(uniforms.center,...[0,1,2].map(k=>(bounds[k]+bounds[k+3])/2));
    // A viewport-aware bounding sphere keeps the complete source box in frame
    // at default zoom, including portrait panels, without changing fit on orbit.
    const diameter=Math.hypot(bounds[3]-bounds[0],bounds[4]-bounds[1],bounds[5]-bounds[2])||1;
    gl.uniform1f(uniforms.scale,1.55*zoom*Math.min(1,w/h)/diameter);gl.uniform1f(uniforms.aspect,w/h);gl.uniform2fv(uniforms.pan,pan);
    environment(floorFactor(X));
    gl.uniform1i(uniforms.line,0);gl.uniform1f(uniforms.alpha,1);
    gl.enableVertexAttribArray(p);gl.enableVertexAttribArray(n);gl.disable(gl.BLEND);gl.depthMask(true);gl.depthFunc(gl.LESS);
    gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);
    const meshPass=()=>{for(const entry of buffers){gl.bindBuffer(gl.ARRAY_BUFFER,entry.buffer);gl.vertexAttribPointer(p,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(n,3,gl.FLOAT,false,24,12);gl.drawArrays(gl.TRIANGLES,0,entry.count);}};
    gl.colorMask(false,false,false,false);meshPass();
    gl.colorMask(true,true,true,true);gl.depthMask(false);gl.depthFunc(gl.LEQUAL);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);meshPass();
    gl.disable(gl.POLYGON_OFFSET_FILL);environment(0,true);gl.disable(gl.BLEND);
    if(edgeReady&&edgeToggle.checked){gl.depthFunc(gl.LEQUAL);gl.depthMask(false);gl.uniform1i(uniforms.line,1);gl.enableVertexAttribArray(p);gl.disableVertexAttribArray(n);gl.vertexAttrib3f(n,0,0,1);for(const entry of edgeBuffers){gl.bindBuffer(gl.ARRAY_BUFFER,entry.buffer);gl.vertexAttribPointer(p,3,gl.FLOAT,false,12,0);gl.drawArrays(gl.LINES,0,entry.count);}}
    gl.depthMask(true);gl.depthFunc(gl.LESS);

  };
  const render = () => {if(!scheduled){scheduled=true;requestAnimationFrame(draw);}};
  let size=0, nextChunk=0, pipelined=false;
  window.addEventListener('message', event => {
    if(port || event.source!==parent || event.data?.type!=='pi-artifact-stream' || event.ports.length!==1) return;
    port=event.ports[0]; size=event.data.size; pipelined=event.data.streamVersion===2;
    port.onmessage=event=>{ try {
      if(failed) return;
      if(event.data?.type==='derive-error'){edgeFailure(event.data.error||'Feature outline generation failed. The full mesh remains available.');return;}
      if(event.data?.type==='derive-status'){edgeStatus.textContent='Generating true feature edges… The model remains usable. Uncheck to cancel.';return;}
      if(ended) throw Error('Stream already completed.');
      if(event.data?.type==='chunk') {
        if (!(event.data.bytes instanceof ArrayBuffer) || (pipelined && (event.data.bytes.byteLength > 1024*1024 || event.data.id !== nextChunk++))) throw Error('Invalid source chunk.');
        const before=performance.now(), previousUpload=uploadMs; consume(new Uint8Array(event.data.bytes));
        decodeMs+=performance.now()-before-(uploadMs-previousUpload);
        if(gl.isContextLost()) throw Error('The graphics context was lost. Open again to restart loading.');
        port.postMessage({type:'ack',id:event.data.id,bytes:event.data.bytes.byteLength,triangles:count,decodeMs,uploadMs});
      }
      else if(event.data?.type==='end') {
        const before=performance.now();
        if(binary===undefined) { parseAscii(pending,true); pending=new Uint8Array(0); } else if(!binary) parseAscii(new Uint8Array(0),true);
        if(bytes!==size || (binary&&(pending.length||count!==expected)) || vertices.length || !count) throw Error('Incomplete or empty STL; full model was not loaded.');
        decodeMs+=performance.now()-before;
        upload(); batch=null; pending=null; ended=true;
        const dimensions=[0,1,2].map(k=>(bounds[k+3]-bounds[k]).toFixed(2)).join(' × ');
        status.textContent=`Full detail · ${count.toLocaleString()} triangles`;
        document.querySelector('#info-count').textContent=`${count.toLocaleString()} source triangles · 100% retained`;
        document.querySelector('#dimensions').textContent=`${dimensions} model units`;
        document.querySelector('#source-size').textContent=`${(size/1048576).toFixed(1)} MiB source · face normals`;
        document.querySelector('#waiting').hidden=true;makeFloor();fit();
        render(); port.postMessage({type:'complete',triangles:count,decodeMs,uploadMs});
      }
    } catch(e) { error(e); } };
    port.postMessage({type:'ready',streamVersion:pipelined?2:1});
  });
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='pi-artifact-derived'||event.ports.length!==1)return;
    const incoming=event.ports[0];
    if(!ended||!edgeLoading||!edgeToggle.checked||edgePort){incoming.close();return;}
    const size=event.data.size;
    if(!Number.isSafeInteger(size)||size<0||size%24||size>128*1048576){incoming.postMessage({type:'error',error:'Invalid feature edge resource.'});edgeFailure('Invalid feature edge resource.');return;}
    edgePort=incoming;let received=0,next=0,tail=new Uint8Array(0),lines=0;
    incoming.onmessage=event=>{try{
      if(event.data?.type==='chunk'){
        if(!(event.data.bytes instanceof ArrayBuffer)||event.data.id!==next++||event.data.bytes.byteLength>1048576)throw Error('Invalid feature edge chunk.');
        const chunk=new Uint8Array(event.data.bytes);received+=chunk.length;if(received>size)throw Error('Feature edge resource changed.');
        const bytes=new Uint8Array(tail.length+chunk.length);bytes.set(tail);bytes.set(chunk,tail.length);const length=bytes.length-bytes.length%24;tail=bytes.slice(length);
        if(length){const data=new Float32Array(bytes.buffer,0,length/4);for(let i=0;i<data.length;i++)if(!Number.isFinite(data[i]))throw Error('Invalid feature edge coordinate.');const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);if(gl.getError()!==gl.NO_ERROR){gl.deleteBuffer(buffer);throw Error('Feature edge GPU allocation failed; the full mesh remains available.');}edgeBuffers.push({buffer,count:length/12});lines+=length/24;}
        incoming.postMessage({type:'ack',id:event.data.id,bytes:chunk.length});
      }else if(event.data?.type==='end'){
        if(received!==size||tail.length)throw Error('Incomplete feature edge resource.');edgeReady=true;edgeLoading=false;edgeToggle.setAttribute('aria-busy','false');edgeStatus.textContent=`${lines.toLocaleString()} true feature edges · 35° source-face crease threshold`;incoming.postMessage({type:'complete'});incoming.close();edgePort=null;render();
      }
    }catch(e){incoming.postMessage({type:'error',error:e.message});edgeFailure(e.message);}};
    incoming.postMessage({type:'ready',streamVersion:2});
  });
  edgeToggle.onchange=()=>{
    if(!ended){edgeToggle.checked=false;edgeStatus.textContent='Load the complete mesh first.';return;}
    if(!edgeToggle.checked){if(edgeLoading){port?.postMessage({type:'derive-cancel'});clearEdges();edgeLoading=false;edgeToggle.setAttribute('aria-busy','false');edgeStatus.textContent='Feature edge generation cancelled.';}render();return;}
    if(edgeReady){render();return;}edgeLoading=true;edgeToggle.setAttribute('aria-busy','true');edgeStatus.textContent='Generating true feature edges… The model remains usable. Uncheck to cancel.';port?.postMessage({type:'derive'});
  };
  canvas.addEventListener('webglcontextlost', event=>{ event.preventDefault(); error(Error('GPU context lost. Try opening the preview again, or download the original.')); });
  const pointers=new Map();
  let mode="orbit";
  const zoomBy = factor => {zoom=Math.max(.15,Math.min(10,zoom*factor));};
  const gesture = () => {const a=[...pointers.values()];return a.length<2?null:{x:(a[0][0]+a[1][0])/2,y:(a[0][1]+a[1][1])/2,d:Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1])};};
  canvas.onpointerdown=e=>{e.preventDefault?.();mode=e.pointerType==="mouse"&&(e.button||e.shiftKey)?"pan":"orbit";canvas.focus({preventScroll:true});pointers.set(e.pointerId,[e.clientX,e.clientY]);canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{const old=pointers.get(e.pointerId);if(!old)return;const before=gesture();pointers.set(e.pointerId,[e.clientX,e.clientY]);const after=gesture();if(before&&after){pan[0]+=(after.x-before.x)/canvas.clientWidth*2;pan[1]-=(after.y-before.y)/canvas.clientHeight*2;if(before.d>0)zoomBy(after.d/before.d);}else{const dx=e.clientX-old[0],dy=e.clientY-old[1];if(mode==="pan"){pan[0]+=dx/canvas.clientWidth*2;pan[1]-=dy/canvas.clientHeight*2;}else{angle[1]-=dx*.009;angle[0]-=dy*.009;markView(null);}}render();};
  canvas.onpointerup=canvas.onpointercancel=canvas.onlostpointercapture=e=>{pointers.delete(e.pointerId);};canvas.oncontextmenu=e=>e.preventDefault();
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoomBy(Math.exp(-e.deltaY*.001));render();},{passive:false});
  canvas.onkeydown=e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const key=e.key.toLowerCase(),step=.10;if(key==='f'){resetView();}else if(key==='+'||key==='='){zoomBy(1.15);}else if(key==='-'){zoomBy(1/1.15);}else if(['arrowleft','arrowright','arrowup','arrowdown'].includes(key)){const dx=key==='arrowleft'?-1:key==='arrowright'?1:0,dy=key==='arrowup'?1:key==='arrowdown'?-1:0;if(e.shiftKey){pan[0]+=dx*.06;pan[1]+=dy*.06;}else{angle[1]+=dx*step;angle[0]+=dy*step;markView(null);}}else return;e.preventDefault();render();};
  document.querySelector('#reset').onclick=()=>{resetView();render();};
  document.querySelector('#up-axis').onchange=()=>{if(ended){makeFloor();render();}};
  for(const control of ['#bounds','#ground','#grid'])document.querySelector(control).onchange=render;
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{angle={iso:[-.58,2.4],front:[0,0],back:[0,Math.PI],left:[0,-Math.PI/2],right:[0,Math.PI/2],top:[-Math.PI/2,0],bottom:[Math.PI/2,0]}[button.dataset.view];fit();markView(button.dataset.view);document.querySelector('#view-menu').open=false;document.querySelector('#view-menu summary').focus();render();};
  markView('iso');
  document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const menu of document.querySelectorAll('details[open]')){menu.open=false;menu.querySelector('summary').focus();}});
  document.addEventListener('pointerdown',event=>{for(const menu of document.querySelectorAll('details[open]'))if(!menu.contains(event.target))menu.open=false;});
  for(const detail of document.querySelectorAll('details'))detail.addEventListener('toggle',()=>{if(detail.open)for(const other of document.querySelectorAll('details'))if(other!==detail)other.open=false;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')for(const detail of document.querySelectorAll('details'))detail.open=false;});
  new ResizeObserver(()=>{if(ended){render();}}).observe(canvas);
  window.addEventListener('pagehide',()=>{port?.postMessage({type:'derive-cancel'});clearEdges();for(const entry of buffers)gl.deleteBuffer(entry.buffer);for(const mesh of [box,ground,grid,shadow])if(mesh){gl.deleteBuffer(mesh.p);gl.deleteBuffer(mesh.a);}port?.close();gl.getExtension('WEBGL_lose_context')?.loseContext();});
})();

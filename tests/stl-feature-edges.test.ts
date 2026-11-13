import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir, truncate, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEdges } from '../examples/pi-web-extensions/3d-modeling/stl-edge-worker.mjs';
import { deriveStlEdges } from '../examples/pi-web-extensions/3d-modeling/stl-edges.js';

type Point = [number,number,number]; type Triangle = [Point,Point,Point];
function binary(triangles: Triangle[]) { const b=Buffer.alloc(84+triangles.length*50);b.writeUInt32LE(triangles.length,80);triangles.forEach((t,i)=>t.flat().forEach((x,k)=>b.writeFloatLE(x,96+i*50+k*4)));return b; }
function lineKey(a:number[],b:number[]){const p=a.join(','),q=b.join(',');return p<q?p+'|'+q:q+'|'+p;}
function lineSet(b:Buffer){const set=new Set<string>();for(let i=0;i<b.length;i+=24){const v=Array.from({length:6},(_,k)=>b.readFloatLE(i+k*4));set.add(lineKey(v.slice(0,3),v.slice(3)));}return set;}
// Independent reproduction of PR277's indexMesh(1e-7) + feature-edge rule.
function originalLines(triangles:Triangle[]){
 const lo=[0,1,2].map(k=>Math.min(...triangles.flat().map(p=>p[k]))),hi=[0,1,2].map(k=>Math.max(...triangles.flat().map(p=>p[k]))),cell=Math.max(...hi.map((x,k)=>x-lo[k]),1)*1e-7;
 const vertices:number[][]=[],ids=new Map<string,number>(),edges=new Map<string,{a:number;b:number;normals:number[][]}>();
 for(const triangle of triangles){const t=triangle.map(p=>{const key=p.map((x,k)=>Math.round((Math.fround(x)-lo[k])/cell)).join(',');if(!ids.has(key)){ids.set(key,vertices.length);vertices.push(p.map(Math.fround));}return ids.get(key)!;});if(new Set(t).size!==3)continue;
 const [a,b,c]=t.map(i=>vertices[i]),u=b.map((x,k)=>x-a[k]),v=c.map((x,k)=>x-a[k]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n)||1,normal=n.map(x=>x/length);
 for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(',');const edge=edges.get(key)??{a,b,normals:[]};edge.normals.push(normal);edges.set(key,edge);}}
 const lines=new Set<string>();for(const {a,b,normals:n} of edges.values())if(n.length!==2||n[0].reduce((sum,x,k)=>sum+x*n[1][k],0)<Math.cos(35*Math.PI/180))lines.add(lineKey(vertices[a],vertices[b]));return lines;
}
async function run(t:Triangle[],extra:Record<string,unknown>={}) { const dir=await mkdtemp(join(tmpdir(),'pi-web-edge-fixture-'));try{const source=join(dir,'input.stl'),destination=join(dir,'lines');await writeFile(source,binary(t));const result=generateEdges({source,destination,scratch:join(dir,'runs'),...extra});return {result,lines:lineSet(await readFile(destination))};}finally{await rm(dir,{recursive:true,force:true});} }
const cube:Point[]=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const cubeTriangles:Triangle[]=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(t=>t.map(i=>cube[i]) as Triangle);
const wedge=(degrees:number):Triangle[]=>[[[0,0,0],[1,0,0],[0,1,0]],[[1,0,0],[0,0,0],[0,-Math.cos(degrees*Math.PI/180),Math.sin(degrees*Math.PI/180)]]];
describe('bounded true source-face feature edges',()=>{
 it('matches original cube edges exactly, excluding face triangulation diagonals',async()=>{const t=await run(cubeTriangles);expect(t.result.lines).toBe(12);expect(t.lines).toEqual(originalLines(cubeTriangles));expect(t.result.boundaries).toBe(0);});
 it('suppresses coplanar seams and smooth (<35°) internal curved joins, retains boundaries and >35° creases',async()=>{for(const degrees of [0,20,34.999,35.001,50,90]){const t=wedge(degrees),out=await run(t);expect(out.result.lines).toBe(degrees>35?5:4);expect(out.lines).toEqual(originalLines(t));}});
 it('matches original boundaries and nonmanifold incidence, retaining exact source even for degenerate input',async()=>{const t=wedge(0);t.push([[0,0,0],[1,0,0],[0,0,1]],[[2,0,0],[2,0,0],[2,0,0]]);const out=await run(t);expect(out.result.nonmanifold).toBe(1);expect(out.result.degenerate).toBe(1);expect(out.result.triangles).toBe(4);expect(out.lines).toEqual(originalLines(t));});
 it('is invariant under representative large translations and scales and matches original clean shared positions',async()=>{for(const [scale,translate]of [[.001,0],[1,10000],[1000,-1000000]]){const t=cubeTriangles.map(face=>face.map(p=>p.map(x=>Math.fround(x*scale+translate))) as Triangle);const out=await run(t);expect(out.result.lines).toBe(12);expect(out.lines).toEqual(originalLines(t));}});
 it('welds near-coincident topology seams but uses raw source normals near threshold, not moved representative faces',async()=>{
  const t=wedge(35.000001);t[1][1]=[0,0,4e-8];const out=await run(t);
  const p=t[1].map(v=>v.map(Math.fround)),u=p[1].map((x,k)=>x-p[0][k]),v=p[2].map((x,k)=>x-p[0][k]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const crease=n[2]/Math.hypot(...n)<Math.cos(35*Math.PI/180);expect(out.result.lines).toBe(crease?5:4);expect(out.result.boundaries).toBe(4);
  expect(out.result.lines).toBe(4);expect(originalLines(t).size).toBe(5); // 34.99999836° raw vs 35.00000023° first-representative welded.
 });
 it('rejects explicit scratch exhaustion instead of silently dropping edges',async()=>{await expect(run(cubeTriangles,{maxScratchBytes:10})).rejects.toThrow('scratch budget');});
 it('supports ASCII source and rejects malformed/nonfinite input',async()=>{const dir=await mkdtemp(join(tmpdir(),'pi-web-edge-ascii-'));try{const source=join(dir,'ascii.stl');await writeFile(source,'solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid a');const out=generateEdges({source,destination:join(dir,'lines'),scratch:join(dir,'scratch')});expect(out.lines).toBe(3);await writeFile(source,Buffer.concat([binary(cubeTriangles),Buffer.from('junk')]));expect(()=>generateEdges({source,destination:join(dir,'bad'),scratch:join(dir,'bad-run')})).toThrow();}finally{await rm(dir,{recursive:true,force:true});}});
 it('rejects corrupt finite cached coordinates and enforces LRU/expiry without retaining excessive disk',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-web-edge-cache-policy-')),root=join(tmpdir(),`pi-web-stl-edges-${process.getuid?.()??'owner'}`),fake=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)].map(n=>join(root,n+'.edges'));
  try{const source=join(dir,'mesh.stl'),data=binary(wedge(81.234));await writeFile(source,data);await deriveStlEdges(source,join(dir,'first'),new AbortController().signal);
   const hash=createHash('sha256').update(data).digest('hex');let selected='';for(const file of await readdir(root))if(file.endsWith('.edges.json')){const m=JSON.parse(await readFile(join(root,file),'utf8'));if(m.sourceHash===hash)selected=join(root,file.slice(0,-5));}expect(selected).not.toBe('');const corrupt=await readFile(selected);corrupt.writeFloatLE(123456,0);await writeFile(selected,corrupt);await deriveStlEdges(source,join(dir,'second'),new AbortController().signal);expect(await readFile(join(dir,'second'))).toEqual(await readFile(join(dir,'first')));
   for(const file of fake){await writeFile(file,'');await truncate(file,300*1048576);}const now=Date.now()/1000;await utimes(fake[0],now-90_000,now-90_000);await utimes(fake[1],now-10,now-10);await deriveStlEdges(source,join(dir,'third'),new AbortController().signal);expect((await readdir(root))).not.toContain(fake[0].split('/').at(-1));expect((await readdir(root))).not.toContain(fake[1].split('/').at(-1));
  }finally{for(const file of fake)await rm(file,{force:true});await rm(dir,{recursive:true,force:true});}
 });
 it('cancels an active owned worker and rejects overlapping work rather than spawning unbounded jobs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-web-edge-active-cancel-')),root=join(tmpdir(),`pi-web-stl-edges-${process.getuid?.()??'owner'}`);try{const source=join(dir,'mesh.stl');await writeFile(source,binary(Array.from({length:100000},(_,i)=>cubeTriangles[i%12])));const abort=new AbortController(),running=deriveStlEdges(source,join(dir,'out'),abort.signal);const failure=expect(running).rejects.toThrow(/cancel|abort/i);await expect(deriveStlEdges(source,join(dir,'overlap'),new AbortController().signal)).rejects.toThrow('Another feature-outline');for(let i=0;i<100;i++){if((await readdir(root)).some(n=>n.startsWith(`job-${process.pid}-`)))break;await new Promise(r=>setTimeout(r,2));}abort.abort();await failure;expect((await readdir(root)).filter(n=>n.startsWith(`job-${process.pid}-`))).toEqual([]);}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('uses immutable hash-invalidated cache and cleans all owned scratch after success/cancel',async()=>{const dir=await mkdtemp(join(tmpdir(),'pi-web-edge-cache-'));try{const source=join(dir,'source.stl');await writeFile(source,binary(cubeTriangles));await deriveStlEdges(source,join(dir,'first'),new AbortController().signal);expect((await readFile(join(dir,'first'))).length).toBe(12*24);await writeFile(source,binary(wedge(0)));await deriveStlEdges(source,join(dir,'second'),new AbortController().signal);expect((await readFile(join(dir,'second'))).length).toBe(4*24);const abort=new AbortController();abort.abort();await expect(deriveStlEdges(source,join(dir,'cancelled'),abort.signal)).rejects.toThrow();const root=join(tmpdir(),`pi-web-stl-edges-${process.getuid?.()??'owner'}`);expect((await readdir(root)).filter(n=>n.startsWith(`job-${process.pid}-`))).toEqual([]);}finally{await rm(dir,{recursive:true,force:true});}},10000);
});

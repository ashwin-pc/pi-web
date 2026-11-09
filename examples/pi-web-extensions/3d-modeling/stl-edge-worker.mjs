// Fixed-memory external edge sort. Runs only in an owned worker, never the server event loop.
import { openSync, closeSync, readSync, writeSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
const RECORD=72, RUN_RECORDS=196608, IO_RECORDS=4096;
const THRESHOLD=Math.cos(35*Math.PI/180);
export const EDGE_ALGORITHM='stl-feature-35-source-normal-weld-1e-7-v1';
function identity(s){return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;}
function scan(path, visit){
 const before=statSync(path,{bigint:true}),fd=openSync(path,'r'),hash=createHash('sha256'),head=Buffer.alloc(84),buf=Buffer.alloc(50*16384);
 let triangles=0;
 try{
  const headLength=readSync(fd,head,0,84,null),count=headLength===84?head.readUInt32LE(80):0;
  if(headLength===84&&84+count*50===Number(before.size)&&count){
   hash.update(head);let left=count;
   while(left){const length=Math.min(left,16384)*50;let got=0;while(got<length){const n=readSync(fd,buf,got,length-got,null);if(!n)throw Error('STL changed during edge generation.');got+=n;}hash.update(buf.subarray(0,length));
    for(let o=0;o<length;o+=50){visit(buf,o+12,triangles++);}left-=length/50;
   }
  }else{
   const decoder=new TextDecoder('utf8',{fatal:true}),triangle=Buffer.alloc(36);let text='',vertices=0,position=0;
   const line=s=>{if(s.length>65536)throw Error('Invalid STL line length.');if(!/^\s*vertex\b/i.test(s))return;const m=/^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/i.exec(s);if(!m)throw Error('Malformed ASCII STL vertex.');for(let k=0;k<3;k++){const x=Number(m[k+1]);if(!Number.isFinite(x))throw Error('STL contains non-finite coordinates.');triangle.writeFloatLE(x,vertices*12+k*4);}if(++vertices===3){visit(triangle,0,triangles++);vertices=0;}};
   while(true){const length=readSync(fd,buf,0,buf.length,position);if(!length)break;position+=length;hash.update(buf.subarray(0,length));text+=decoder.decode(buf.subarray(0,length),{stream:true});let at;while((at=text.indexOf('\n'))>=0){line(text.slice(0,at));text=text.slice(at+1);}if(text.length>65536)throw Error('Invalid STL line length.');}text+=decoder.decode();if(text)line(text);if(vertices||!triangles)throw Error('Incomplete or empty STL.');
  }
 }finally{closeSync(fd);}
 if(identity(before)!==identity(statSync(path,{bigint:true})))throw Error('STL changed during edge generation.');
 return {hash:hash.digest('hex'),identity:identity(before),triangles};
}
export function generateEdges({source,destination,scratch,maxScratchBytes=1536*1024*1024}){
 mkdirSync(scratch,{recursive:true,mode:0o700});
 const start=performance.now(),bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
 const first=scan(source,(b,o)=>{for(let v=0;v<3;v++)for(let k=0;k<3;k++){const x=b.readFloatLE(o+v*12+k*4);if(!Number.isFinite(x))throw Error('STL contains non-finite coordinates.');bounds[k]=Math.min(bounds[k],x);bounds[k+3]=Math.max(bounds[k+3],x);}});
 // Worst case includes every run plus an all-boundary output. Reject before allocating disk.
 if(first.triangles*3*(RECORD+24)>maxScratchBytes)throw Error('Feature outline scratch budget exceeded (1.5 GiB); the full mesh is unchanged.');
 const cell=Math.max(bounds[3]-bounds[0],bounds[4]-bounds[1],bounds[5]-bounds[2],1)*1e-7;
 const storage=Buffer.allocUnsafe(RUN_RECORDS*RECORD),view=new DataView(storage.buffer,storage.byteOffset,storage.byteLength),order=new Uint32Array(RUN_RECORDS),sorted=Buffer.allocUnsafe(storage.length),runs=[];
 let used=0,records=0,degenerate=0,peak=process.memoryUsage().rss;
 const compare=(a,b)=>{for(let k=0;k<6;k++){const d=view.getInt32(a*RECORD+k*4,true)-view.getInt32(b*RECORD+k*4,true);if(d)return d;}return 0;};
 const flush=()=>{if(!used)return;for(let i=0;i<used;i++)order[i]=i;order.subarray(0,used).sort(compare);for(let i=0;i<used;i++)storage.copy(sorted,i*RECORD,order[i]*RECORD,(order[i]+1)*RECORD);const path=`${scratch}/run-${runs.length}`;const fd=openSync(path,'wx',0o600);try{writeSync(fd,sorted,0,used*RECORD);}finally{closeSync(fd);}runs.push(path);used=0;peak=Math.max(peak,process.memoryUsage().rss);parentPort?.postMessage({type:'progress',phase:'sort',records,runs:runs.length});};
 const xyz=new Float64Array(9),keys=new Int32Array(9);
 const second=scan(source,(b,o)=>{
  for(let i=0;i<9;i++){xyz[i]=b.readFloatLE(o+i*4);keys[i]=Math.round((xyz[i]-bounds[i%3])/cell);}
  const same=(a,c)=>keys[a]===keys[c]&&keys[a+1]===keys[c+1]&&keys[a+2]===keys[c+2];
  if(same(0,3)||same(0,6)||same(3,6)){degenerate++;return;}
  const ux=xyz[3]-xyz[0],uy=xyz[4]-xyz[1],uz=xyz[5]-xyz[2],vx=xyz[6]-xyz[0],vy=xyz[7]-xyz[1],vz=xyz[8]-xyz[2];
  let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;const length=Math.hypot(nx,ny,nz)||1;nx/=length;ny/=length;nz/=length;
  for(let e=0;e<3;e++){
   let a=e*3,c=((e+1)%3)*3;for(let k=0;k<3;k++){if(keys[a+k]===keys[c+k])continue;if(keys[a+k]>keys[c+k])[a,c]=[c,a];break;}
   const offset=used*RECORD;for(let k=0;k<3;k++){view.setInt32(offset+k*4,keys[a+k],true);view.setInt32(offset+12+k*4,keys[c+k],true);view.setFloat32(offset+48+k*4,xyz[a+k],true);view.setFloat32(offset+60+k*4,xyz[c+k],true);}
   view.setFloat64(offset+24,nx,true);view.setFloat64(offset+32,ny,true);view.setFloat64(offset+40,nz,true);used++;records++;if(used===RUN_RECORDS)flush();
  }
 });flush();if(first.hash!==second.hash||first.identity!==second.identity)throw Error('STL changed during edge generation.');
 // One small input buffer per sorted run; heap stores run indices, never edge objects.
 const readers=runs.map(path=>({fd:openSync(path,'r'),b:Buffer.alloc(IO_RECORDS*RECORD),at:0,end:0}));
 const refill=r=>{r.end=readSync(r.fd,r.b,0,r.b.length,null);r.at=0;if(r.end%RECORD)throw Error('Malformed private edge run.');return !!r.end;};
 const keyCompare=(a,b)=>{const x=readers[a],y=readers[b];for(let k=0;k<6;k++){const d=x.b.readInt32LE(x.at+k*4)-y.b.readInt32LE(y.at+k*4);if(d)return d;}return 0;};
 const heap=[];function push(i){let p=heap.length;heap.push(i);while(p){const q=(p-1)>>1;if(keyCompare(heap[q],i)<=0)break;heap[p]=heap[q];p=q;}heap[p]=i;}function pop(){const top=heap[0],last=heap.pop();if(heap.length){let p=0;while(p*2+1<heap.length){let c=p*2+1;if(c+1<heap.length&&keyCompare(heap[c+1],heap[c])<0)c++;if(keyCompare(last,heap[c])<=0)break;heap[p]=heap[c];p=c;}heap[p]=last;}return top;}
 const output=Buffer.alloc(24*8192),group=Buffer.alloc(RECORD),outputHash=createHash('sha256'),out=openSync(destination,'wx',0o600);let outUsed=0,lines=0,incidents=0,dot=1,boundaries=0,creases=0,nonmanifold=0;
 function emit(){if(!incidents)return;if(incidents===2&&dot>=THRESHOLD)return;group.copy(output,outUsed,48,72);outUsed+=24;lines++;if(incidents===1)boundaries++;else if(incidents===2)creases++;else nonmanifold++;if(outUsed===output.length){outputHash.update(output);writeSync(out,output);outUsed=0;}}
 try{
  readers.forEach((r,i)=>{if(refill(r))push(i);});
  while(heap.length){const i=pop(),r=readers[i];let same=incidents>0;for(let k=0;same&&k<6;k++)same=group.readInt32LE(k*4)===r.b.readInt32LE(r.at+k*4);
   if(!same){emit();r.b.copy(group,0,r.at,r.at+RECORD);incidents=1;dot=1;}else{incidents++;if(incidents===2)dot=group.readDoubleLE(24)*r.b.readDoubleLE(r.at+24)+group.readDoubleLE(32)*r.b.readDoubleLE(r.at+32)+group.readDoubleLE(40)*r.b.readDoubleLE(r.at+40);}
   r.at+=RECORD;if(r.at<r.end||refill(r))push(i);
  }emit();if(outUsed){outputHash.update(output.subarray(0,outUsed));writeSync(out,output,0,outUsed);}
 }finally{closeSync(out);for(const r of readers)closeSync(r.fd);for(const path of runs)unlinkSync(path);}
 peak=Math.max(peak,process.memoryUsage().rss);
 return {algorithm:EDGE_ALGORITHM,sourceHash:first.hash,outputHash:outputHash.digest('hex'),triangles:first.triangles,lines,boundaries,creases,nonmanifold,degenerate,cell,records,scratchBytes:records*RECORD+lines*24,workingBufferBytes:storage.length+sorted.length+order.byteLength+readers.length*IO_RECORDS*RECORD+output.length+819200,peakRssBytes:peak,elapsedMs:performance.now()-start};
}
if(parentPort&&workerData){try{parentPort.postMessage({type:'complete',result:generateEdges(workerData)});}catch(error){parentPort.postMessage({type:'error',error:error.message});}}

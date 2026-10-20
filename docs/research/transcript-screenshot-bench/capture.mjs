// Read-only capture. Run from the repo root; outputs contain private transcript/image data.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {default: WebSocket} = await import(pathToFileURL(resolve('game/node_modules/ws/wrapper.mjs')));
import {writeFile,mkdir} from 'node:fs/promises';
const [socket,id,dir] = process.argv.slice(2);
if (!socket || !id || !dir) throw Error('usage: node capture.mjs SOCKET WORKER_ID PRIVATE_OUTPUT_DIR');
await mkdir(dir,{recursive:true,mode:0o700});
const ws=new WebSocket('ws+unix:'+socket+':/ws');
const pending=new Map();let seq=0;
ws.on('message', b=>{let m=JSON.parse(b);if(pending.has(m.req_id)){let p=pending.get(m.req_id); pending.delete(m.req_id); m.t==='error'?p.reject(Error(m.code+': '+m.message)):p.resolve({...m.data,_wire:b.length});}});
await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)});ws.send(JSON.stringify({t:'hello',proto:1,client:'screenshot-investigation'}));
async function cmd(t,args){const req_id='bench-'+ ++seq; const p=new Promise((resolve,reject)=>pending.set(req_id,{resolve,reject})); ws.send(JSON.stringify({t,req_id,args}));return await p;}
let start=performance.now();const watch=await cmd('transcript.watch',{id,limit:200});console.log('watch', {ms:performance.now()-start,bytes:watch._wire,items:watch.items.length});
await writeFile(dir+'/watch.json',JSON.stringify(watch));
start=performance.now();let list=await cmd('transcript.images',{id,limit:1000});console.log('images list',{ms:performance.now()-start,bytes:list._wire,count:list.images.length,has_more:list.has_more});await writeFile(dir+'/refs.json',JSON.stringify(list));
const refs=[...new Map(list.images.filter(x=>x.hash&&!x.unavailable&&x.mime!=='binary').map(x=>[x.hash,x])).values()];
await mkdir(dir+'/images',{recursive:true});await mkdir(dir+'/thumbs',{recursive:true});
const results=[];
for(let i=0;i<refs.length;i++){
 const r=refs[i];let times=[];let a;
 for(let k=0;k<3;k++){start=performance.now();a=await cmd('transcript.image',{id,hash:r.hash,size:'thumb'});times.push(performance.now()-start);}
 const data=Buffer.from(a.data,'base64');await writeFile(dir+'/thumbs/'+r.hash+'.png',data);
 // Originals only for a bounded sample, never fetch the entire transcript.
 if(i<30){const f=await cmd('transcript.image',{id,hash:r.hash,size:'full'}); await writeFile(dir+'/images/'+r.hash+'.png',Buffer.from(f.data,'base64'));}
 results.push({hash:r.hash,sourceMime:r.mime,sourceWidth:r.width,sourceHeight:r.height,thumbMime:a.mime,width:a.width,height:a.height,bytes:data.length,wire:a._wire,ms:times});
}
await writeFile(dir+'/capture-results.json',JSON.stringify(results,null,2));console.log('summary', {unique:results.length,thumbBytes:results.reduce((a,b)=>a+b.bytes,0),wire:results.reduce((a,b)=>a+b.wire,0),firstTotalMs:results.reduce((a,b)=>a+b.ms[0],0),warmTotalMs:results.reduce((a,b)=>a+b.ms[1],0)}); ws.close();

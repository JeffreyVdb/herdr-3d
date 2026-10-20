// Isolated real transcript renderer: no 3D scene, all image responses already local.
// Run from repo root through portlease after capture.mjs and codecs.py.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {createServer}=await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
import {readFile,writeFile} from 'node:fs/promises';
const root=resolve('game'), dir=process.argv[2];
if (!dir || !process.env.PORTLEASE_BENCH_PORT) throw Error('usage: portlease run ... --name bench -- node browser.mjs PRIVATE_CAPTURE_DIR');
const server=await createServer({root,server:{host:'127.0.0.1',port:Number(process.env.PORTLEASE_BENCH_PORT),strictPort:true}});await server.listen();
const browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:1});
page.on('pageerror', e=>console.error(e.message));
await page.route('**/__bench', route=>route.fulfill({contentType:'text/html',body:`<style>html,body,#root{height:100%;margin:0}#root{width:1000px} .tx {height:100%}</style><link rel="stylesheet" href="/src/ui/themes.css"><link rel="stylesheet" href="/src/ui/uiTheme.css"><link rel="stylesheet" href="/src/laptop/transcript.css"><div id="root"></div><script type="module">import {mountTranscript} from '/src/laptop/transcriptRender.ts'; import {ImageFeed} from '/src/laptop/imageFeed.ts';window.mountTranscript=mountTranscript;window.ImageFeed=ImageFeed;window.ready=true;</script>`}));
await page.goto('http://127.0.0.1:'+process.env.PORTLEASE_BENCH_PORT+'/__bench');await page.waitForFunction(()=>window.ready);
const watch=JSON.parse(await readFile(dir+'/watch.json','utf8'));const capture=JSON.parse(await readFile(dir+'/capture-results.json','utf8'));
const summary=[];
for(const variant of ['current','without-images','webp-nearlossless-q75','webp-q82','avif-q55','current','without-images','webp-q82','avif-q55']){
 const data={};for(const r of capture){const keep=['current','without-images'].includes(variant)||r.sourceMime==='image/jpeg';const ext=keep?'png':variant.split('-')[0];const bytes=await readFile(`${dir}/${keep?'thumbs':variant}/${r.hash}.${ext}`);data[r.hash]={mime:keep?r.thumbMime:'image/'+ext,width:r.width,height:r.height,bytes:bytes.length,size:'thumb',data:bytes.toString('base64')};}
 const result=await page.evaluate(async({items,data})=>{
  const root=document.getElementById('root');let feed;const requests=[];const long=[];const po=new PerformanceObserver(l=>long.push(...l.getEntries().map(x=>x.duration)));po.observe({type:'longtask',buffered:false});
  feed=new window.ImageFeed('bench',{send:async(t,a)=>{requests.push(a.hash);return {ok:true,data:data[a.hash]};}});feed.note(items);
  const t0=performance.now(); const view=window.mountTranscript(root,{images:feed,onPromptSubmit:async()=>true,onAnswer:()=>{},onAnswerAsk:async()=>({ok:true,resolved:true}),onSwitchToTerminal:()=>{},loadSubagent:async()=>[]});view.setItems(items);const resetMs=performance.now()-t0;
  const scroller=root.querySelector('.tx-scroll');await new Promise(r=>setTimeout(r,100));
  const cold=performance.now();
  // Traverse every screen with layout/paint between steps, exercising production IntersectionObserver and ImageFeed.
  let gaps=[],last=performance.now();for(let y=0;y<scroller.scrollHeight;y+=700){scroller.scrollTop=y;await new Promise(requestAnimationFrame);const now=performance.now();gaps.push(now-last);last=now;}
  await new Promise(r=>setTimeout(r,100));await Promise.all([...root.querySelectorAll('img[src]')].map(i=>i.decode().catch(()=>{})));const traverseMs=performance.now()-cold;
  const warmStart=performance.now();let warmGaps=[],lastWarm=performance.now();for(let y=scroller.scrollHeight;y>=0;y-=700){scroller.scrollTop=y;await new Promise(requestAnimationFrame);const now=performance.now();warmGaps.push(now-lastWarm);lastWarm=now;}
  const sort=a=>[...a].sort((x,y)=>x-y); const p95=a=>sort(a)[Math.floor(a.length*.95)]||0;
  const out={resetMs,traverseMs,warmTraverseMs:performance.now()-warmStart,requests:requests.length,loaded:root.querySelectorAll('img[src]').length,nodes:root.querySelectorAll('*').length,scrollHeight:scroller.scrollHeight,longTasks:long.length,maxLongTask:Math.max(0,...long),maxFrameGap:Math.max(...gaps),p95FrameGap:p95(gaps),warmMaxFrameGap:Math.max(...warmGaps),warmP95FrameGap:p95(warmGaps)};
  po.disconnect();view.destroy();feed.dispose();root.replaceChildren();return out;
 },{items:variant==='without-images'?watch.items.map(i=>({...i,parts:i.parts?.filter(p=>!p.image),tool:i.tool?{...i.tool,images:[]}:undefined})):watch.items,data:variant==='without-images'?{}:data}); summary.push({variant,...result});console.log(variant,result);
}
await writeFile(dir+'/browser-results.json',JSON.stringify({browser:browser.version(),results:summary},null,2));await browser.close();await server.close();

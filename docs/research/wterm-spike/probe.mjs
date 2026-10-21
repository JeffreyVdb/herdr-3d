import assert from 'node:assert/strict';
import {writeFile, mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {serve} from './server.mjs';

const server=await serve();
const browser=await chromium.launch({headless:true});
const results=[];
await mkdir(new URL('artifacts/',import.meta.url),{recursive:true});
async function grid(page) {
  return page.evaluate(()=>{
    const t=window.spike.term;
    const r=document.querySelector('.xterm-screen,.term-grid').getBoundingClientRect();
    return {x:r.x,y:r.y,cw:r.width/t.cols,ch:r.height/t.rows,cols:t.cols,rows:t.rows};
  });
}
try {
  for(const engine of ['xterm','wterm','wterm-ghostty']) {
    console.log(`${engine}: starting`);
    const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>d.accept());
    await page.addInitScript(()=>{
      window.opened=[];
      window.open=url=>{if(url)window.opened.push(String(url));return{opener:null,location:{set href(url){window.opened.push(url);}}};};
      document.addEventListener('click',e=>{
        const link=e.target.closest?.('a');
        if(link&&(e.ctrlKey||e.metaKey)) {window.opened.push(link.href);e.preventDefault();}
      });
    });
    const r={engine};
    try {
      await page.goto(`${server.url}/?engine=${engine}`);
      await page.waitForFunction(()=>window.spike?.state.ready&&window.spike.state.resizes.length);
      await page.waitForTimeout(200);
      r.full=await grid(page);
      // Native selection is exercised on a fresh mount, before resize/reload.
      // Use visible text coordinates, outside the start-of-line caret boundary.
      await page.mouse.move(r.full.x+10,r.full.y+70);
      await page.mouse.down();
      await page.mouse.move(r.full.x+180,r.full.y+70,{steps:15});
      await page.mouse.up();
      await page.waitForTimeout(100);
      r.selection=await page.evaluate(()=>window.spike.selection());
      r.nativeSelection=await page.evaluate(()=>window.getSelection()?.toString());
      await page.evaluate(()=>navigator.clipboard.writeText('COPY SENTINEL'));
      await page.keyboard.press('Control+c');
      await page.waitForTimeout(100);
      r.copied=await page.evaluate(()=>navigator.clipboard.readText());
      r.clipboardViaHost=await page.evaluate(async selected=>{
        await navigator.clipboard.writeText(selected??'');
        return navigator.clipboard.readText();
      },r.selection);
      await page.evaluate(()=>window.spike.clearSelection());
      await page.locator('#split').click();
      await page.waitForFunction(cols=>window.spike.term.cols<cols&&window.spike.state.resizes.at(-1).cols===window.spike.term.cols,r.full.cols);
      r.split=await grid(page);
      r.fixedFont=Math.abs(r.full.cw-r.split.cw)<0.01&&Math.abs(r.full.ch-r.split.ch)<0.01;
      r.ptyResize=await page.evaluate(()=>window.spike.state.resizes.at(-1));
      await page.reload();
      await page.waitForFunction(()=>window.spike?.state.ready&&window.spike.state.resizes.length);
      await page.waitForTimeout(200);
      const g=await grid(page);
      const point=(col,row)=>({x:g.x+(col-0.5)*g.cw,y:g.y+(row-0.5)*g.ch});
      await page.keyboard.down('Control');
      for(const row of [2,3]) {
        const p=point(6,row);
        await page.mouse.move(p.x,p.y);
        await page.waitForTimeout(180);
        await page.mouse.click(p.x,p.y);
      }
      await page.keyboard.up('Control');
      r.links=await page.evaluate(()=>window.opened);
      r.plainLink=r.links.includes('https://example.com/plain');
      r.osc8Link=r.links.includes('https://example.com/osc8');
      await page.evaluate(()=>window.spike.term.focus());
      await page.keyboard.type('KEYBOARD');
      await page.waitForFunction(()=>window.spike.state.inputs.join('').includes('KEYBOARD'));
      r.keyboard=true;
      await page.evaluate(()=>navigator.clipboard.writeText('PASTE ONE\nPASTE TWO'));
      await page.keyboard.press('Control+Shift+v');
      await page.waitForFunction(()=>window.spike.state.inputs.join('').includes('PASTE ONE'));
      r.pastePacket=await page.evaluate(()=>window.spike.state.inputs.find(s=>s.includes('PASTE ONE')));
      r.bracketedPaste=/^\x1b\[200~PASTE ONE[\r\n]PASTE TWO\x1b\[201~$/.test(r.pastePacket);
      await page.locator('#menu').click();
      await page.waitForFunction(()=>window.spike.state.output.includes('Mouse-enabled TUI'));
      await page.waitForTimeout(100);
      const freshOption=point(8,5);
      await page.mouse.click(freshOption.x,freshOption.y);
      await page.waitForTimeout(150);
      r.mouseFresh=await page.evaluate(()=>({reports:window.spike.state.inputs.filter(s=>s.includes('\x1b[<')),selected:window.spike.state.output.includes('SELECTED 1 by mouse')}));
      await page.evaluate(()=>window.spike.send('q'));
      await page.waitForTimeout(100);
      await page.evaluate(()=>{window.spike.state.inputs=[];window.spike.state.output='';});
      await page.locator('#history').click();
      await page.waitForFunction(()=>window.spike.state.output.includes('HISTORY END'));
      await page.waitForTimeout(150);
      r.scrollBefore=await page.evaluate(()=>window.spike.scroll());
      const center=point(30,12);
      await page.mouse.move(center.x,center.y);
      await page.mouse.wheel(0,-900);
      await page.waitForTimeout(200);
      r.scrollAfter=await page.evaluate(()=>window.spike.scroll());
      r.wheelHistory=r.scrollBefore!==r.scrollAfter;
      await page.evaluate(()=>window.spike.bottom());
      await page.locator('#menu').click();
      await page.waitForFunction(()=>window.spike.state.output.includes('Mouse-enabled TUI'));
      await page.waitForTimeout(100);
      r.menuGeometry=await page.evaluate(()=>({scroll:document.querySelector('#terminal').scrollTop, gridY:document.querySelector('.term-grid')?.getBoundingClientRect().y, mouse:window.spike.term.bridge?.mouseTracking(),sgr:window.spike.term.bridge?.mouseSgr(),history:window.spike.history()}));
      const option=point(8,5);
      await page.mouse.click(option.x,option.y);
      await page.waitForTimeout(150);
      r.mouse=await page.evaluate(()=>({reports:window.spike.state.inputs.filter(s=>s.includes('\x1b[<')),selected:window.spike.state.output.includes('SELECTED 1 by mouse')}));
      if(!r.mouse.selected) {
        await page.evaluate(()=>window.spike.term.focus());
        await page.mouse.click(option.x,option.y);
        await page.waitForTimeout(100);
        r.mouseAfterRefocus=await page.evaluate(()=>({reports:window.spike.state.inputs.filter(s=>s.includes('\x1b[<')),selected:window.spike.state.output.includes('SELECTED 1 by mouse')}));
      }
      await page.keyboard.press('2');
      await page.waitForFunction(()=>window.spike.state.output.includes('SELECTED 2 by keyboard'));
      r.keyboardMenu=true;
      await page.evaluate(()=>window.spike.send('q'));
      await page.waitForTimeout(150);
      await page.locator('#history').click();
      await page.waitForTimeout(150);
      r.historyBeforeReset=await page.evaluate(()=>window.spike.history());
      await page.evaluate(()=>window.spike.write('\x1bcFresh full frame'));
      r.historyAfterReset=await page.evaluate(()=>window.spike.history());
      r.truecolor=await page.evaluate(async()=>{
        await window.spike.write('\x1bc\x1b[38;2;12;123;234mX\x1b[0m');
        return window.spike.cell(0,0);
      });
      r.graphemes=await page.evaluate(async()=>{
        await window.spike.write('\x1bc'+'e\u0301'+'👨‍👩‍👧‍👦'+'Z');
        return Array.from({length:7},(_,c)=>window.spike.cell(0,c));
      });
      r.reflow=await page.evaluate(async()=>{
        const t=window.spike.term;
        t.resize(20,10);
        await window.spike.write('\x1bcABCDEFGHIJKLMNOPQR');
        t.resize(10,10);
        t.resize(20,10);
        await window.spike.write('');
        const lines=[];
        for(let r=0;r<3;r++) lines.push(Array.from({length:20},(_,c)=>{const x=window.spike.cell(r,c);return x.chars??String.fromCodePoint(x.char||32);}).join('').trimEnd());
        return lines;
      });
      r.clearHistory=await page.evaluate(async()=>{
        window.spike.term.resize(80,15);
        await window.spike.write('\x1bc'+Array.from({length:300},(_,i)=>`line ${i}`).join('\r\n'));
        window.spike.term.focus();
        await window.spike.write('\x1b[3J\x1b[H\x1b[2J$ ');
        const host=document.querySelector('#terminal');
        const row=document.querySelector('.term-row');
        return {history:window.spike.history(),scroll:window.spike.scroll(),scrollHeight:host.scrollHeight,clientHeight:host.clientHeight,firstRowY:row?.getBoundingClientRect().y,hostY:host.getBoundingClientRect().y};
      });
      await page.screenshot({path:new URL(`artifacts/${engine}-clear.png`,import.meta.url).pathname});
      if(engine!=='xterm') {
        r.scaledFit=await page.evaluate(()=>window.spike.scaledFit());
      }
    }catch(e){r.failure=e.message;}
    r.errors=errors;
    results.push(r);
    console.log(JSON.stringify(r,null,2));
    await writeFile(new URL('results.json',import.meta.url),JSON.stringify({date:'2026-10-21',environment:'Linux; Chromium 149.0.7827.55 via Playwright 1.61.1, 1280x900, same isolated Python PTY fixture as issue #176; no real Herdr/Claude/Codex',results},null,2)+'\n');
    await context.close();
  }
  assert.ok(results.every(r=>!r.failure&&!r.errors.length),'Probe execution failure; see recorded results');
}finally{await browser.close();await server.close();}

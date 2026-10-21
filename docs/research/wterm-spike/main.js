import '@xterm/xterm/css/xterm.css';
import '@wterm/dom/css';

const engine = new URLSearchParams(location.search).get('engine') || 'xterm';
const host = document.querySelector('#terminal');
const state = { engine, inputs: [], binaryInputs: [], resizes: [], output: '', ready: false };
let ws, term, fit;
const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const send = (s) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'input', data:encode(new TextEncoder().encode(s))}));
};
const sendSize = () => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
};
if (engine === 'xterm') {
  const [{Terminal}, {FitAddon}, {WebLinksAddon}] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]);
  term = new Terminal({fontSize:16, fontFamily:'monospace', scrollback:2000});
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(host);
  fit.fit();
  term.onData(send);
  term.onResize(sendSize);
} else {
  const {WTerm} = await import('@wterm/dom');
  let core;
  if (engine === 'wterm-ghostty') {
    const {GhosttyCore} = await import('@wterm/ghostty');
    const {default:wasmPath} = await import('@wterm/ghostty/ghostty-vt.wasm?url');
    core = await GhosttyCore.load({wasmPath, scrollbackLimit:4*1024*1024});
  }
  term = new WTerm(host, {core, onData:send, onResize:sendSize, onBinary(bytes) {
    state.binaryInputs.push(Array.from(bytes));
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'input', data:encode(bytes)}));
  }});
  await term.init();
}
const resize = () => { if (fit) fit.fit(); sendSize(); };
ws = new WebSocket(`ws://${location.host}/pty`);
ws.addEventListener('open', () => { resize(); term.focus(); });
ws.addEventListener('message', ({data}) => {
  const msg = JSON.parse(data);
  if (msg.type === 'output') {
    const bytes = Uint8Array.from(atob(msg.data), c=>c.charCodeAt(0));
    state.output += new TextDecoder().decode(bytes);
    if (engine === 'xterm') term.write(bytes, () => {state.ready=true;});
    else {term.write(bytes); state.ready=true;}
  } else if (msg.type === 'input') state.inputs.push(msg.data);
  else if (msg.type === 'resize') state.resizes.push({cols:msg.cols, rows:msg.rows});
  document.querySelector('#status').textContent = JSON.stringify({grid:[term.cols,term.rows], pty:state.resizes.at(-1)});
});
if (fit) new ResizeObserver(resize).observe(host);
document.querySelector('#split').onclick = () => {host.classList.toggle('narrow'); resize(); term.focus();};
document.querySelector('#history').onclick = () => {send('h'); term.focus();};
document.querySelector('#menu').onclick = () => {send('m'); term.focus();};
const write = async (data) => {
  if (engine === 'xterm') await new Promise(resolve => term.write(data,resolve));
  else term.write(data);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
};
const history = () => engine === 'xterm' ? term.buffer.active.length-term.rows : term.bridge.getScrollbackCount();
const scroll = () => engine === 'xterm' ? term.buffer.active.viewportY : host.scrollTop;
const bottom = () => engine === 'xterm' ? term.scrollToBottom() : host.scrollTo(0,host.scrollHeight);
const selection = () => engine === 'xterm' ? term.getSelection() : term.getSelectionText();
const clearSelection = () => term.clearSelection();
const cell = (r,c) => engine === 'xterm' ? (()=>{const x=term.buffer.active.getLine(term.buffer.active.baseY+r)?.getCell(c);return {chars:x?.getChars(),width:x?.getWidth(),fg:x?.getFgColor(),fgRGB:x?.isFgRGB()};})() : term.bridge.getCell(r,c);
window.spike={term,state,send,resize,write,history,scroll,bottom,selection,clearSelection,cell,async scaledFit() {
  const {WTerm}=await import('@wterm/dom');
  const sizes=[];
  for(const scale of [1,0.5]) {
    const parent=document.createElement('div');
    parent.style.cssText=`position:fixed;left:0;top:0;transform:scale(${scale});transform-origin:0 0`;
    const host=document.createElement('div');
    host.style.cssText='width:800px;height:400px;padding:0';
    parent.append(host);document.body.append(parent);
    let core;
    if(engine === 'wterm-ghostty') {
      const {GhosttyCore}=await import('@wterm/ghostty');
      const {default:wasmPath}=await import('@wterm/ghostty/ghostty-vt.wasm?url');
      core=await GhosttyCore.load({wasmPath});
    }
    const t=new WTerm(host,{core});await t.init();
    const style=getComputedStyle(host);
    sizes.push({scale,cols:t.cols,rows:t.rows,cw:style.getPropertyValue('--term-cell-width'),rh:style.getPropertyValue('--term-row-height')});
    t.destroy();core?.dispose();parent.remove();
  }
  return sizes;
}};

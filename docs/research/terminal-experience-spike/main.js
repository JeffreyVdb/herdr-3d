import '@xterm/xterm/css/xterm.css';

const engine = new URLSearchParams(location.search).get('engine') || 'xterm';
const host = document.querySelector('#terminal');
const status = document.querySelector('#status');
const options = { fontSize: 16, fontFamily: 'monospace', scrollback: 2000, cursorBlink: false, theme: { background: '#10162a', foreground: '#dde4f3' } };
let term, fit;
const started = performance.now();
if (engine === 'xterm') {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links'),
  ]);
  term = new Terminal(options);
  fit = new FitAddon();
  term.loadAddon(new WebLinksAddon());
} else {
  const next = engine === 'ghostty-next';
  const lib = await (next ? import('ghostty-next') : import('ghostty-web'));
  const wasm = await (next ? import('ghostty-next/ghostty-vt.wasm?url') : import('ghostty-web/ghostty-vt.wasm?url'));
  const ghostty = await lib.Ghostty.load(wasm.default);
  term = new lib.Terminal({ ...options, ghostty });
  fit = new lib.FitAddon();
}
term.loadAddon(fit);
term.open(host);
fit.fit();
const state = { engine, initMs: performance.now() - started, inputs: [], resizes: [], output: '', ready: false };
const ws = new WebSocket(`ws://${location.host}/pty`);
const encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const send = (s) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: encode(s) })); };
const resize = () => {
  fit.fit();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
};
const describe = () => {
  status.textContent = `${engine} · ${term.cols} × ${term.rows} · font 16px\nPTY size: ${JSON.stringify(state.resizes.at(-1) ?? null)}\nLast input: ${JSON.stringify(state.inputs.at(-1) ?? '')}`;
};
term.onData(send);
term.onResize(({ cols, rows }) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
});
ws.addEventListener('open', () => { resize(); term.focus(); });
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === 'output') {
    const bytes = Uint8Array.from(atob(msg.data), (s) => s.charCodeAt(0));
    state.output += new TextDecoder().decode(bytes);
    term.write(bytes, () => { state.ready = true; describe(); });
  } else if (msg.type === 'input') state.inputs.push(msg.data);
  else if (msg.type === 'resize') state.resizes.push({ cols: msg.cols, rows: msg.rows });
  describe();
});
new ResizeObserver(resize).observe(host);
document.querySelector('#split').onclick = () => { host.classList.toggle('narrow'); resize(); term.focus(); };
document.querySelector('#history').onclick = () => { send('h'); term.focus(); };
document.querySelector('#menu').onclick = () => { send('m'); term.focus(); };
document.querySelector('#reset').onclick = () => location.reload();
// Deliberately exposed research hooks; never imported by the game.
window.spike = { term, state, send, resize, fit };

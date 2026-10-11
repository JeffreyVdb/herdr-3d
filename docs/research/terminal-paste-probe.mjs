// Investigation harness, not an application test. Requires make dev and agent-browser.
// node docs/research/terminal-paste-probe.mjs http://127.0.0.1:<leased-dev-port>
// Exit 1 means terminal paste still submits a prompt or cannot reach a question.
import { execFileSync } from 'node:child_process';

const origin = new URL(process.argv[2] ?? '');
if (origin.hostname !== '127.0.0.1') throw new Error('Use the loopback Vite dev server');
const session = `terminal-paste-probe-${process.pid}`;
const browser = (...args) => {
  const reply = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8' }));
  if (!reply.success) throw new Error(reply.error);
  return reply.data;
};
const evaluate = (source) => browser('eval', `(() => { ${source} })()`).result;
const report = {};

try {
  const url = new URL('/', origin);
  url.search = new URLSearchParams({ backend: 'webgl2', ws: '/fixture/demo-m4?play=none&sim=1&simms=150', time: '2026-09-30T12:00' });
  browser('--args', '--use-angle=vulkan,--enable-features=Vulkan,--ignore-gpu-blocklist', 'open', url.href);
  browser('wait', '--fn', 'window.__h3d?.ready && window.__h3d.frames >= 3');
  evaluate(`
    window.__h3d.enterFloor('herdr-3d');
    window.__probePastes = [];
    document.addEventListener('paste', e => window.__probePastes.push({ target: e.target.className, trusted: e.isTrusted, text: e.clipboardData?.getData('text/plain') }));
    const source = document.createElement('textarea');
    source.id = 'probe-copy-source';
    source.value = 'REVIEW_BEFORE_ENTER';
    source.addEventListener('keydown', e => e.stopPropagation());
    document.body.append(source);
    source.focus(); source.select();
  `);
  // Real browser copy/paste shortcuts; no synthetic ClipboardEvent or async clipboard permission.
  browser('press', 'Control+c');
  browser('wait', '--fn', 'window.__h3d.layout("herdr-3d") !== null');
  evaluate(`
    const worker = window.__h3d.world().find(f => f.session === 'herdr-3d').workers.find(w => w.name === 'Nibble');
    window.__probeWorker = worker.id;
    localStorage.setItem('h3d.seat.terminal', JSON.stringify([worker.id]));
    if (!window.__h3d.sitAt(worker.id)) throw new Error('Could not sit at fixture Claude worker');
  `);
  browser('wait', '--fn', 'window.__h3d.seat().mode === "terminal" && document.activeElement.classList.contains("seat-input")');
  browser('press', 'Control+v');
  browser('wait', '--fn', 'window.__probePastes.length > 0');
  report.normalPrompt = evaluate(`
    const commands = window.__h3d.sent().filter(c => c.t === 'worker.prompt' || c.t === 'worker.keys');
    return { paste: window.__probePastes.at(-1), commands, insertsWithoutSubmitting: commands.length > 0 && commands.every(c => c.t === 'worker.keys' && !c.args.input.some(i => i.key === 'enter')) };
  `);
  if (report.normalPrompt.paste.text !== 'REVIEW_BEFORE_ENTER' || !report.normalPrompt.paste.trusted) throw new Error('Native clipboard setup failed');
  evaluate(`return window.__h3d.simAsk({ id: window.__probeWorker, ask: { tool_use_id: 'paste-probe-question', agent: 'claude', questions: [{ header: 'Answer', question: 'What should we do?', multi: false, other: true, options: [{ label: 'Continue', description: 'Proceed' }] }] } });`);
  evaluate(`window.__probeBeforeQuestion = window.__h3d.sent().length;`);
  browser('press', 'Control+v');
  browser('wait', '--fn', 'window.__h3d.sent().slice(window.__probeBeforeQuestion).some(c => c.t === "worker.prompt" || c.t === "worker.keys")');
  browser('wait', '--fn', 'window.__h3d.sent().slice(window.__probeBeforeQuestion).every(c => !["worker.prompt", "worker.keys"].includes(c.t) || c.result !== undefined)');
  report.question = evaluate(`
    const commands = window.__h3d.sent().slice(window.__probeBeforeQuestion).filter(c => c.t === 'worker.prompt' || c.t === 'worker.keys');
    return { paste: window.__probePastes.at(-1), commands, seat: window.__h3d.seat(), insertsWithoutSubmitting: commands.length > 0 && commands.every(c => c.t === 'worker.keys' && c.result.ok && !c.args.input.some(i => i.key === 'enter')) };
  `);
  evaluate(`return window.__h3d.simAsk({ id: window.__probeWorker, ask: null });`);
  evaluate(`window.__probeBeforeFocus = window.__h3d.sent().length; window.__probePasteCount = window.__probePastes.length;`);
  browser('focus', '.btn--menu');
  browser('press', 'Control+v');
  browser('wait', '--fn', 'window.__probePastes.length > window.__probePasteCount');
  report.focusMoved = evaluate(`return { focus: document.activeElement.className, paste: window.__probePastes.at(-1), commands: window.__h3d.sent().slice(window.__probeBeforeFocus).filter(c => c.t === 'worker.prompt' || c.t === 'worker.keys') };`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.normalPrompt.insertsWithoutSubmitting && report.question.insertsWithoutSubmitting ? 0 : 1;
} finally {
  browser('close');
}

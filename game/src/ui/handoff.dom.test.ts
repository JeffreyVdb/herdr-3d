// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HandoffCandidate, HandoffEntry, HandoffPreviewAck, Worker } from '../net/protocol';
import { HandoffBook } from '../world/handoff';
import { HandoffLLMBook } from '../world/handoffLlm';
import { Cabinet } from './cabinet';
import { HandoffDialog } from './handoffDialog';

// #223: the filing dialog (exact text, provenance, the send-home choice, success and failure, a stale reply) and the
// cabinet (list, safe search snippets, sanitised preview, copy, delete with a confirm, hire from a handoff).

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 70000, images: 1 };
const TEXT = '  # Loader\n\n```go\nfunc main() {}\n```\n  ';
const PREVIEW: HandoffPreviewAck = {
  candidate: CAND,
  text: TEXT,
  truncated: true,
  title: 'Loader',
  provenance: { floor: 'herdr-3d', worker_name: 'Pixel', label: 'h3d-223', harness: 'claude', model: 'opus', branch: 'h3d/223-handoff', session: 'sess-123456789' },
  can_send_home: true,
};
const ENTRY: HandoffEntry = { id: 7, floor: 'herdr-3d', worker_id: 'A', worker_name: 'Pixel', branch: 'h3d/x', harness: 'claude', model: 'claude-opus-5-5', cwd: '/w/x', path: '/home/u/handoff/herdr-3d/20261010-1559-pixel-loader.md', title: 'Loader', created_at: Date.UTC(2026, 9, 10, 15, 59), source: 'literal', bytes: 300 };

type Reply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function setup(worker: Partial<Worker> = {}, replies: Record<string, Reply[]> = {}) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const copies: string[] = [];
  const cabinets: Array<[string, number | undefined]> = [];
  const hires: HandoffEntry[] = [];
  const w: Worker = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'h3d-223', agent_kind: 'claude', status: 'idle', handoff: CAND, ...worker } as Worker;
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: { 'herdr-3d': 1 } });
  const handoffLlm = new HandoffLLMBook(); // #9: an older bridge's: no LLM handoffs
  const store = {
    workerView: (id: string) => (store.workers.get(id) ? { name: 'Pixel', desk: 2, harness: 'claude', display: 'idle', worker: store.workers.get(id) } : null),
    workers: new Map([['A', w]]),
    handoffs,
    handoffLlm,
    ai: { state: null as { llm: { model: string } } | null },
  };
  const host = {
    store,
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => 0,
    copy: async (t: string) => (copies.push(t), true),
    openCabinet: (f: string, s?: number) => cabinets.push([f, s]),
    hireFrom: (e: HandoffEntry) => hires.push(e),
    send: (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, args });
      const q = replies[cmd];
      const r = q && q.length > 1 ? q.shift() : q?.[0];
      return Promise.resolve(r ?? { ok: true, data: {} });
    },
  };
  const flush = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const q = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-key="${key}"]`)!;
  const hook = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-hook="${key}"]`);
  return { host, store, w, sent, toasts, copies, cabinets, hires, flush, q, hook };
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => document.body.replaceChildren());

describe('HandoffDialog', () => {
  it('previews the exact text with its provenance, and files it literally (no send home unless ticked)', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }], 'worker.handoff': [{ ok: true, data: { handoff: ENTRY } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', candidate: 'cand-1' } });
    expect(e.hook('ho-text')?.textContent).toBe(TEXT); // as text, whitespace and fences kept
    expect(e.hook('ho-text')?.querySelector('*')).toBeNull();
    expect(e.hook('ho-title')?.textContent).toBe('Loader');
    expect(e.hook('ho-notes')?.textContent).toMatch(/the whole reply is filed.*An image in this message is not text/);
    expect(e.hook('ho-prov')?.textContent).toContain('h3d/223-handoff');
    e.q('file').click();
    await e.flush();
    const filed = e.sent.find((x) => x.cmd === 'worker.handoff');
    expect(filed?.args).toMatchObject({ worker: 'A', mode: 'literal', session: 'sess', candidate: 'cand-1', revision: 'rev-1' });
    expect(filed?.args.send_home).toBeUndefined();
    expect(String(filed?.args.op)).toMatch(/^ho-/);
    expect(d.summary().state).toBe('filed');
    expect(e.hook('ho-path')?.textContent).toBe(ENTRY.path);
    e.q('copy').click();
    await e.flush();
    expect(e.copies).toEqual([ENTRY.path]);
    e.q('cabinet').click();
    expect(e.cabinets).toEqual([['herdr-3d', 7]]);
  });

  it('sends home only when ticked, and says why it did not', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }], 'worker.handoff': [{ ok: true, data: { handoff: ENTRY, send_home: 'skipped', send_home_reason: 'Pixel is working' } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    const box = document.getElementById('ho-send-home') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(e.q('file').textContent).toContain('File, then send home');
    e.q('file').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'worker.handoff')?.args.send_home).toBe(true);
    expect(e.hook('ho-home')?.textContent).toBe('Pixel was not sent home: Pixel is working.');
  });

  it('offers no send home when the worker cannot go, and keeps the op on a retry after a failure', async () => {
    const e = setup({}, {
      'worker.handoff_preview': [{ ok: true, data: { ...PREVIEW, can_send_home: false, send_home_blocked: 'Pixel is blocked: it waits on you' } }],
      'worker.handoff': [
        { ok: false, code: 'handoff_failed', message: 'filing the handoff failed: disk full' },
        { ok: true, data: { handoff: ENTRY } },
      ],
    });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect((document.getElementById('ho-send-home') as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById('ho-send-hint')?.textContent).toContain('Not now: Pixel is blocked');
    e.q('file').click();
    await e.flush();
    expect(d.summary()).toMatchObject({ state: 'ready', error: true });
    expect(d.summary().status).toContain('Nobody was sent home');
    e.q('file').click();
    await e.flush();
    const ops = e.sent.filter((x) => x.cmd === 'worker.handoff').map((x) => x.args.op);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBe(ops[1]);
    expect(d.summary().state).toBe('filed');
  });

  it('a newer reply makes the preview stale: File is off until the latest is shown', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    e.w.handoff = { ...CAND, id: 'cand-2', revision: 'rev-2' };
    d.refresh();
    expect(d.summary().stale).toBe(true);
    expect(e.q('file').getAttribute('aria-disabled')).toBe('true');
    e.q('file').click();
    await e.flush();
    expect(e.sent.some((x) => x.cmd === 'worker.handoff')).toBe(false);
    e.q('reload').click();
    await e.flush();
    expect(e.sent.at(-1)).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', candidate: 'cand-2' } });
  });

  it('without a candidate it says why and offers nothing else (never a summary)', async () => {
    const e = setup({ status: 'working' });
    delete (e.w as Partial<Worker>).handoff;
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(d.summary().state).toBe('none');
    expect(e.hook('ho-why')?.textContent).toMatch(/working/);
    expect(e.sent).toEqual([]);
    expect([...document.querySelectorAll('.dd-actions button')].map((b) => b.textContent)).toEqual(['Close']);
  });
});

describe('Cabinet', () => {
  const LIST = { floor: 'herdr-3d', handoffs: [{ ...ENTRY, snippet: '…the \uE000<img src=x onerror="window.__pwned=1">\uE001 here…' }] };
  const BODY = '# Loader\n\n<script>window.__pwned=1</script><img src="https://evil/x.png" onerror="window.__pwned=1">\n\n- one';

  it('lists, searches with text-only snippets, shows sanitised Markdown, copies and hires from a handoff', async () => {
    const e = setup({}, { 'handoff.list': [{ ok: true, data: LIST }], 'handoff.get': [{ ok: true, data: { handoff: ENTRY, body: BODY } }] });
    const c = new Cabinet(document.body, e.host as never);
    c.open('herdr-3d');
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'handoff.list', args: { floor: 'herdr-3d' } });
    const mark = document.querySelector('.cab-snippet mark');
    expect(mark?.textContent).toBe('<img src=x onerror="window.__pwned=1">');
    expect(document.querySelector('.cab-snippet img')).toBeNull();
    (document.querySelector('.cab-row') as HTMLElement).click();
    await e.flush();
    const doc = e.hook('cab-doc') as HTMLElement;
    expect(doc.querySelector('h1')?.textContent).toBe('Loader');
    expect(doc.querySelector('script, img, [onerror]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    e.q('copy').click();
    await e.flush();
    expect(e.copies).toEqual([ENTRY.path]);
    e.q('hire').click();
    expect(e.hires.map((h) => h.id)).toEqual([7]);
  });

  it('deletes only after a confirm, to the trash', async () => {
    const e = setup({}, { 'handoff.list': [{ ok: true, data: LIST }], 'handoff.get': [{ ok: true, data: { handoff: ENTRY, body: 'x' } }], 'handoff.delete': [{ ok: true, data: { handoff: ENTRY } }] });
    const c = new Cabinet(document.body, e.host as never);
    c.open('herdr-3d', 7);
    await e.flush();
    expect(c.summary().selected).toBe(7);
    e.q('delete').click();
    expect(c.summary().confirming).toBe(true);
    expect(e.sent.some((x) => x.cmd === 'handoff.delete')).toBe(false);
    e.q('keep').click();
    expect(c.summary().confirming).toBe(false);
    e.q('delete').click();
    e.q('confirm-delete').click();
    await e.flush();
    expect(e.sent.find((x) => x.cmd === 'handoff.delete')?.args).toEqual({ id: 7, confirm: true });
    expect(c.summary().rows).toEqual([]);
    expect(c.summary().status).toContain('trash');
  });
});

// #224: "Ask the agent" in the same dialog: the modes, the instruction, the cache estimate as an estimate, the
// request followed on the worker until it is filed or fails, and no switch made for you.
describe('HandoffDialog: Ask the agent', () => {
  const AGENT_PV: HandoffPreviewAck = {
    candidate: CAND,
    text: TEXT,
    title: 'Loader',
    provenance: PREVIEW.provenance,
    can_send_home: true,
    agent: { call: '/handoff', can_ask: true, harness: 'claude', model: 'opus', instruction: 'summarize the conversation' },
    cache: {
      state: 'expired',
      estimated: true,
      evidence: { estimated: true, policy: 'observed_1h', ttl_min_ms: 3_600_000, ttl_max_ms: 3_600_000, request_from: 1, request_to: 2, expires_from: 3_600_001, expires_to: 3_600_002, context_tokens: 48_200 },
    },
  };
  const ask = (worker: Partial<Worker> = {}, more: Record<string, Reply[]> = {}) =>
    setup(worker, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }, { ok: true, data: AGENT_PV }], ...more });
  const choose = (m: string) => {
    const r = document.querySelector<HTMLInputElement>(`[data-key="mode:${m}"]`)!;
    r.checked = true;
    r.dispatchEvent(new Event('change'));
  };

  it('offers the three modes, literal by default, the configured LLM shown but off', async () => {
    const e = ask();
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(d.summary().mode).toBe('literal');
    expect(e.hook('ho-modes')?.textContent).toMatch(/Save last message.*Nothing is sent to any model.*Ask the agent.*Pixel’s agent \(claude\) writes it; its provider reads the conversation.*Use configured LLM.*The bridge sends a reduced, scrubbed copy of the conversation to the LLM set in Settings, not Pixel’s agent\. This bridge can’t write handoffs with an LLM/);
    expect(document.querySelector<HTMLInputElement>('[data-key="mode:llm"]')!.disabled).toBe(true);
    expect(e.sent.map((x) => x.cmd)).toEqual(['worker.handoff_preview']);
  });

  it('asks with the instruction and send home, says the estimate in the ticket’s words, then follows the request to filed', async () => {
    const e = ask({}, { 'worker.handoff': [{ ok: true, data: { request: { op: 'x', state: 'pending', started_at: 1, instruction: 'focus on tests', send_home: true } } }], 'handoff.get': [{ ok: true, data: { handoff: { ...ENTRY, source: 'agent' }, body: '# Loader' } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    choose('agent');
    await e.flush();
    expect(e.sent[1]).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', mode: 'agent', candidate: 'cand-1' } });
    const s = d.summary();
    expect(s.mode).toBe('agent');
    expect(s.canAsk).toBe(true);
    expect(s.cache).toBe('expired');
    expect(s.cacheLine).toContain('Estimate · May have expired');
    expect(s.cacheLine).toContain('Agent cache may have expired. Generating a handoff can process the current conversation context again (about 48k tokens).');
    expect(s.cacheLine).not.toMatch(/JSONL/);
    expect(e.q('use-literal').textContent).toBe('Save the last message instead');
    const instr = document.getElementById('ho-instruction') as HTMLTextAreaElement;
    expect(instr.placeholder).toBe('summarize the conversation');
    instr.value = '  focus on tests ';
    const box = document.getElementById('ho-send-home') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(e.q('file').textContent).toContain('Ask, then send home');
    e.q('file').click();
    await e.flush();
    const sent = e.sent.find((x) => x.cmd === 'worker.handoff')!;
    expect(sent.args).toMatchObject({ worker: 'A', mode: 'agent', instruction: 'focus on tests', send_home: true });
    expect(String(sent.args.op)).toMatch(/^ho-/);
    expect(d.summary().state).toBe('pending');
    expect(e.hook('ho-request')?.textContent).toMatch(/Asked since .*within 10 minutes/);
    // The bridge files it: the dialog shows where.
    e.w.agent_handoff = { op: 'x', state: 'filed', started_at: 1, handoff: 7, send_home_result: 'started' };
    d.refresh();
    await e.flush();
    expect(d.summary().state).toBe('filed');
    expect(e.hook('ho-path')?.textContent).toBe(ENTRY.path);
    expect(e.hook('ho-home')?.textContent).toBe('Pixel is on the way home; the worktree is kept.');
  });

  it('says why the agent can’t be asked, and never switches mode for you', async () => {
    const e = setup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }, { ok: true, data: { ...AGENT_PV, agent: { can_ask: false, cannot_ask: 'claude lists no "handoff" skill in /w', instruction: 'summarize the conversation' } } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    choose('agent');
    await e.flush();
    expect(e.hook('ho-cannot')?.textContent).toContain('lists no "handoff" skill');
    expect(e.q('file').getAttribute('aria-disabled')).toBe('true');
    e.q('file').click();
    await e.flush();
    expect(e.sent.some((x) => x.cmd === 'worker.handoff')).toBe(false);
    expect(d.summary().mode).toBe('agent');
  });

  it('opens on a failed request, says why, dismisses it or asks again with a new op', async () => {
    const e = setup({ agent_handoff: { op: 'old', state: 'failed', started_at: 1, reason: 'a person took over' } }, { 'worker.handoff_preview': [{ ok: true, data: AGENT_PV }], 'worker.handoff_cancel': [{ ok: true, data: {} }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    expect(d.summary().state).toBe('failed');
    expect(e.hook('ho-reason')?.textContent).toBe('a person took over');
    expect(e.hook('ho-request')?.textContent).toContain('Pixel stays; nobody was sent home.');
    e.q('ask-again').click();
    await e.flush();
    expect(d.summary().state).toBe('ready');
    expect(d.summary().request).toBeNull();
    expect(e.sent.at(-1)).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', mode: 'agent', candidate: 'cand-1' } });
  });

  it('cancels a running request', async () => {
    const e = setup({ agent_handoff: { op: 'run', state: 'pending', started_at: 1 } }, { 'worker.handoff_cancel': [{ ok: true, data: { op: 'run', state: 'failed', started_at: 1, reason: 'cancelled' } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    expect(d.summary().state).toBe('pending');
    expect(e.hook('ho-modes')).toBeNull();
    e.q('cancel-request').click();
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'worker.handoff_cancel', args: { worker: 'A', op: 'run' } });
    expect(d.summary().state).toBe('failed');
    expect(e.hook('ho-reason')?.textContent).toBe('cancelled');
  });
});

describe('HandoffDialog: one mode row', () => {
  it('draws the modes once in every agent state', async () => {
    const e = setup({ agent_handoff: { op: 'old', state: 'failed', started_at: 1, reason: 'x' } });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    expect(document.querySelectorAll('[data-hook="ho-modes"]')).toHaveLength(1);
  });
});

// #9: "Use configured LLM": off with the exact reason and a way to Settings until the feature is ready; never chosen
// for you; the preview names the recipient and what goes; the job is followed; a failure keeps the dialog.
const LLM_STATE = { enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, input_bytes: 98304, max_tokens: 4096, reasoning_effort: '', reasoning: { support: 'unknown', efforts: ['low'], listed: false }, effort_stale: false, timeout_s: 90, prompt_version: 'h3d-handoff-llm-1', categories: ['your prompts to the worker', 'your handoff instruction'] };
const LLM_PREVIEW: HandoffPreviewAck = {
  candidate: CAND,
  provenance: { floor: 'herdr-3d', worker_name: 'Pixel', harness: 'claude', model: 'opus', session: 'sess-123456789' },
  can_send_home: true,
  llm: {
    ready: true,
    model: 'gpt-handoff',
    host: 'llm.example:8443',
    payload_bytes: 24_700,
    est_tokens: 8_300,
    budget_bytes: 98_304,
    max_tokens: 4096,
    timeout_s: 90,
    prompt_version: 'h3d-handoff-llm-1',
    reduced: true,
    coverage: { messages: 40, kept: 12, omitted: [{ from: 3, to: 20, why: 'older assistant detail' }], compaction: 'none', gaps: ['older tool output left out'], complete: false },
    redactions: { github_token: 2, url_credentials: 1 },
    categories: ['your prompts to the worker', 'your handoff instruction'],
    artifacts: 2,
    verified: 1,
  },
};
const RUNNING = { op: 'x', state: 'running', started_at: 1, updated_at: 1, model: 'gpt-handoff', host: 'llm.example:8443' } as const;

function llmSetup(worker: Partial<Worker> = {}, replies: Record<string, Reply[]> = {}, state: unknown = LLM_STATE) {
  const e = setup(worker, replies);
  e.store.handoffLlm.reset(state);
  return e;
}

describe('HandoffDialog: Use configured LLM', () => {
  it('is off, with the exact reason and a way to Settings, until the feature is ready; literal stays the default', async () => {
    const opened: string[] = [];
    const e = llmSetup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }] }, { ...LLM_STATE, enabled: false, state: 'off', tested: false });
    const d = new HandoffDialog(document.body, { ...e.host, openSettings: (s: string) => opened.push(s) } as never);
    d.open('A');
    await e.flush();
    expect(d.summary().mode).toBe('literal');
    expect(document.querySelector<HTMLInputElement>('[data-key="mode:llm"]')!.disabled).toBe(true);
    expect(e.hook('ho-modes')?.textContent).toContain('LLM handoffs are off. Switch them on in Settings › LLM handoffs after a passing test.');
    e.q('llm-settings').click();
    expect(opened).toEqual(['handoff-llm']);
    expect(e.sent.every((x) => x.args.mode !== 'llm')).toBe(true);
  });

  it('previews the recipient, size, coverage and redactions, then writes with the instruction and follows the job', async () => {
    const e = llmSetup({}, {
      'worker.handoff_preview': [{ ok: true, data: PREVIEW }, { ok: true, data: LLM_PREVIEW }],
      'worker.handoff': [{ ok: true, data: { job: RUNNING } }],
      'handoff.get': [{ ok: true, data: { handoff: { ...ENTRY, source: 'llm' }, body: '# Loader', llm: { model: 'gpt-handoff' } } }],
    });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    const llm = document.querySelector<HTMLInputElement>('[data-key="mode:llm"]')!;
    expect(llm.disabled).toBe(false);
    llm.checked = true;
    llm.dispatchEvent(new Event('change'));
    await e.flush();
    expect(e.sent.at(-1)).toEqual({ cmd: 'worker.handoff_preview', args: { worker: 'A', mode: 'llm', candidate: 'cand-1' } });
    const s = d.summary();
    expect(s.mode).toBe('llm');
    expect(s.recipient).toBe('gpt-handoff at llm.example:8443');
    expect(s.payload).toBe('24.1 KB of transcript, about 8,300 tokens (budget 96 KB)');
    expect(s.coverage).toContain('12 of 40 messages.');
    expect(s.coverage).toContain('Left out: messages 3–20 (older assistant detail).');
    expect(e.hook('ho-gaps')?.textContent).toBe('older tool output left out');
    expect(s.redactions).toBe('Removed before sending: 2 GitHub tokens, 1 password in a URL.');
    expect(e.hook('ho-llm-sent')?.textContent).toContain('your handoff instruction');
    (document.getElementById('ho-instruction') as HTMLTextAreaElement).value = '  the CI failure  ';
    e.q('file').click();
    await e.flush();
    const sent = e.sent.find((x) => x.cmd === 'worker.handoff');
    expect(sent?.args).toMatchObject({ worker: 'A', mode: 'llm', session: 'sess', candidate: 'cand-1', revision: 'rev-1', instruction: 'the CI failure' });
    expect(String(sent?.args.op)).toMatch(/^ho-/);
    expect(d.summary().state).toBe('pending');
    expect(e.hook('ho-job')?.textContent).toContain('gpt-handoff at llm.example:8443 is writing the handoff');
    e.w.llm_handoff = { ...RUNNING, state: 'filed', handoff: 7 }; // the ack's job (the fake acks op x)
    d.refresh();
    await e.flush();
    expect(d.summary().state).toBe('filed');
    expect(e.hook('ho-written-by')?.textContent).toBe('Written by gpt-handoff at llm.example:8443; Pixel was not asked.');
  });

  it('keeps the dialog on a refusal and on a failed job; Try again is a new request', async () => {
    const e = llmSetup({}, {
      'worker.handoff_preview': [{ ok: true, data: PREVIEW }, { ok: true, data: LLM_PREVIEW }],
      'worker.handoff': [
        { ok: false, code: 'handoff_llm_unavailable', message: 'the LLM is not ready: set it up in Settings, AI integration; nothing was sent' },
        { ok: true, data: { job: RUNNING } },
      ],
    });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    const llm = document.querySelector<HTMLInputElement>('[data-key="mode:llm"]')!;
    llm.checked = true;
    llm.dispatchEvent(new Event('change'));
    await e.flush();
    e.q('file').click();
    await e.flush();
    expect(d.summary().state).toBe('ready');
    expect(d.summary().error).toBe(true);
    expect(d.summary().status).toContain('Nothing was sent');
    e.q('file').click();
    await e.flush();
    e.w.llm_handoff = { ...RUNNING, state: 'failed', code: 'timeout', message: 'the LLM did not answer within 90 s; it was not sent again; nothing was filed' };
    d.refresh();
    expect(d.summary().state).toBe('failed');
    expect(e.hook('ho-reason')?.textContent).toContain('not sent again');
    expect(e.hook('ho-job')?.textContent).toContain('nobody was sent home');
    expect(e.q('retry').textContent).toBe('Try again (new request)');
    const before = e.sent.filter((x) => x.cmd === 'worker.handoff').length;
    e.q('retry').click();
    await e.flush();
    expect(e.sent.at(-1)?.args).toMatchObject({ mode: 'llm' }); // a new preview, nothing sent by itself
    expect(e.sent.filter((x) => x.cmd === 'worker.handoff').length).toBe(before);
    expect(d.summary().state).toBe('ready');
  });

  it('says why it can’t be written now (the preview’s reason) and keeps Write off', async () => {
    const e = llmSetup({}, { 'worker.handoff_preview': [{ ok: true, data: PREVIEW }, { ok: true, data: { ...LLM_PREVIEW, llm: { ...LLM_PREVIEW.llm!, ready: false, reduced: false, unavailable: 'another LLM handoff is being written: one at a time' } } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    await e.flush();
    const llm = document.querySelector<HTMLInputElement>('[data-key="mode:llm"]')!;
    llm.checked = true;
    llm.dispatchEvent(new Event('change'));
    await e.flush();
    expect(e.hook('ho-llm-cannot')?.textContent).toContain('one at a time');
    expect(e.q('file').getAttribute('aria-disabled')).toBe('true');
    e.q('file').click();
    await e.flush();
    expect(e.sent.some((x) => x.cmd === 'worker.handoff')).toBe(false);
  });

  it('reopens on a running job and cancels it', async () => {
    const e = llmSetup({ llm_handoff: RUNNING }, { 'worker.handoff_cancel': [{ ok: true, data: { ...RUNNING, state: 'cancelled', message: 'cancelled; nothing was filed' } }] });
    const d = new HandoffDialog(document.body, e.host as never);
    d.open('A');
    expect(d.summary().state).toBe('pending');
    expect(d.summary().mode).toBe('llm');
    e.q('cancel-request').click();
    await e.flush();
    expect(e.sent[0]).toEqual({ cmd: 'worker.handoff_cancel', args: { worker: 'A', op: 'x' } });
    expect(d.summary().state).toBe('failed');
    expect(e.hook('ho-reason')?.textContent).toBe('cancelled; nothing was filed');
  });
});

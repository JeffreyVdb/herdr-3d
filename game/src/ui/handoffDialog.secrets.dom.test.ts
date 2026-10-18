// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HandoffCandidate, HandoffPreviewAck, Worker } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { HandoffBook } from '../world/handoff';
import { HandoffLLMBook } from '../world/handoffLlm';
import { HandoffDialog } from './handoffDialog';

// #108 round 4: "Ask the agent"'s instruction through the review: nothing asked before Confirm, the request carries the
// review; a blank instruction (the default one) has nothing to review; Cancel asks nothing.

const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess', revision: 'rev-1', harness: 'claude', message: 'msg_1', source: 'message', bytes: 70 };
const PV: HandoffPreviewAck = { candidate: CAND, text: 'x', title: 'T', provenance: { floor: 'f', worker_name: 'Pixel', label: 'l', harness: 'claude', model: 'opus', branch: 'b', session: 's' }, can_send_home: true };
const AGENT_PV: HandoffPreviewAck = { ...PV, agent: { call: '/handoff', can_ask: true, harness: 'claude', model: 'opus', instruction: 'summarize the conversation' } };
const INSTR = 'say the staging PASSWORD=hunter22 is in the vault';

/** An LLM preview of the same reply (#9), and the feature ready. */
const LLM_PV: HandoffPreviewAck = { ...PV, llm: { ready: true, model: 'gpt-handoff', host: 'llm.example:8443', payload_bytes: 100, est_tokens: 30, budget_bytes: 98_304, max_tokens: 4096, timeout_s: 90, prompt_version: 'v1', reduced: false, coverage: { messages: 2, kept: 2, omitted: [], compaction: 'none', gaps: [], complete: true }, redactions: {}, categories: ['your handoff instruction'], artifacts: 0, verified: 0 } };
const LLM_STATE = { enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, input_bytes: 98304, max_tokens: 4096, reasoning_effort: '', reasoning: { support: 'unknown', efforts: ['low'], listed: false }, effort_stale: false, timeout_s: 90, prompt_version: 'v1', categories: ['your handoff instruction'] };

/** `handoff`: `worker.handoff`'s answers in turn (then an ack); two workers, A (Pixel) and B (Pebble). */
function setup(o: { on?: boolean; handoff?: CommandResult[] } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const previews = [PV, AGENT_PV];
  const answers = [...(o.handoff ?? [])];
  const w = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'h3d', agent_kind: 'claude', status: 'idle', handoff: CAND } as Worker;
  const wB = { ...w, id: 'B', label: 'B worker' };
  const workers = new Map([
    ['A', w],
    ['B', wB],
  ]);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const handoffLlm = new HandoffLLMBook();
  handoffLlm.reset(LLM_STATE);
  const view = (id: string) => {
    const worker = workers.get(id);
    return worker ? { name: id === 'A' ? 'Pixel' : 'Pebble', desk: id === 'A' ? 2 : 3, harness: 'claude', display: 'idle', worker } : null;
  };
  const store = { floorName: (id: string) => id, workerView: view, workers, handoffs, handoffLlm, ai: { state: null } };
  const host = {
    store,
    unsupported: () => false,
    toast: () => {},
    now: () => 0,
    copy: async () => true,
    openCabinet: () => {},
    hireFrom: () => {},
    secrets: b.flow,
    send: (cmd: string, args: Record<string, unknown>): Promise<CommandResult> => {
      sent.push({ cmd, args });
      if (cmd === 'worker.handoff_preview') return Promise.resolve({ ok: true, data: args.mode === 'llm' ? LLM_PV : (previews.shift() ?? AGENT_PV) });
      if (cmd === 'worker.handoff' && args.mode === 'llm') return Promise.resolve(answers.shift() ?? { ok: true, data: { job: { op: 'x', state: 'running', started_at: 1, updated_at: 1, model: 'gpt-handoff', host: 'llm.example:8443' } } });
      if (cmd === 'worker.handoff') return Promise.resolve(answers.shift() ?? { ok: true, data: { request: { op: 'x', state: 'pending', started_at: 1 }, protected: 1 } });
      return Promise.resolve({ ok: true, data: {} });
    },
  };
  const d = new HandoffDialog(document.body, host as never);
  const asks = () => sent.filter((x) => x.cmd === 'worker.handoff').map((x) => x.args);
  const toMode = async (mode: 'agent' | 'llm', instruction: string, worker = 'A') => {
    d.open(worker);
    await flush();
    const r = document.querySelector<HTMLInputElement>(`[data-key="mode:${mode}"]`)!;
    r.checked = true;
    r.dispatchEvent(new Event('change'));
    await flush();
    (document.getElementById('ho-instruction') as HTMLTextAreaElement).value = instruction;
  };
  const toAgent = (instruction: string, worker = 'A') => toMode('agent', instruction, worker);
  const file = () => document.querySelector<HTMLElement>('.desk-dlg [data-key="file"]')!.click();
  return { b, d, asks, toAgent, toMode, file };
}

describe('HandoffDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('an instruction with a secret: reviewed first, nothing asked before Confirm, the request carries the review', async () => {
    const e = setup();
    await e.toAgent(INSTR);
    e.file();
    await flush();
    expect(e.b.open()).toMatchObject({ target: 'Pixel', counts: { found: 1 } });
    expect(e.asks()).toEqual([]);
    e.b.confirm();
    await flush();
    const [args] = e.asks();
    expect(args).toMatchObject({ worker: 'A', mode: 'agent', instruction: INSTR, secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    expect(e.b.gate(INSTR, args!.secrets, 'A')).toMatchObject({ protected: 1 });
  });

  it('Cancel asks nothing and keeps the instruction; a blank instruction (the default) is asked as today', async () => {
    const e = setup();
    await e.toAgent(INSTR);
    e.file();
    await flush();
    e.b.cancel();
    await flush();
    expect(e.asks()).toEqual([]);
    expect(e.d.summary()).toMatchObject({ state: 'ready', status: 'Not sent: the instruction is still here.' });
    const blank = setup();
    await blank.toAgent('');
    blank.file();
    await flush();
    expect(blank.b.scans).toEqual([]);
    expect(blank.asks()).toEqual([expect.not.objectContaining({ secrets: expect.anything() })]);
  });

  // #108 round 4 fix (D1): the review's scan is a window in which the dialog can close, or open for another worker.
  // Nothing of the cancelled ask goes: not to the worker it was for, not to the one shown now.
  it('closed while the instruction is scanned: nothing is asked and no review opens (clean or with a secret)', async () => {
    for (const instruction of ['Summarize the staging work.', INSTR]) {
      const e = setup();
      await e.toAgent(instruction);
      const release = e.b.holdScans();
      e.file();
      await flush();
      e.d.close();
      release();
      await flush();
      expect(e.d.isOpen).toBe(false);
      expect(e.b.open()).toBeNull();
      expect(e.asks()).toEqual([]);
    }
  });

  it('closed and opened for another worker while it is scanned: nothing is asked of either', async () => {
    const e = setup();
    await e.toAgent('Summarize the staging work.');
    const release = e.b.holdScans();
    e.file();
    await flush();
    e.d.close();
    e.d.open('B');
    await flush();
    release();
    await flush();
    expect(e.asks()).toEqual([]);
    expect(e.d.summary()).toMatchObject({ worker: 'B' });
  });

  it('the ask carries what it was pressed with: Send home ticked while scanned stays for the next ask', async () => {
    const e = setup();
    await e.toAgent('Summarize the staging work.');
    const release = e.b.holdScans();
    e.file();
    await flush();
    const box = document.querySelector<HTMLInputElement>('[data-key="send-home"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    release();
    await flush();
    expect(e.asks()).toEqual([expect.not.objectContaining({ send_home: true })]);
    expect(e.asks()[0]).toMatchObject({ worker: 'A', mode: 'agent', instruction: 'Summarize the staging work.' });
  });

  it('refused as stale, then closed while it is scanned again: asked once, never again', async () => {
    const e = setup({ handoff: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await e.toAgent(INSTR);
    e.file();
    await flush();
    const release = e.b.holdScans();
    e.b.confirm();
    await flush();
    expect(e.asks()).toHaveLength(1);
    e.d.close();
    release();
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.asks()).toHaveLength(1);
  });

  it('“Write with the LLM”: closed while its instruction is scanned, nothing is sent to the LLM', async () => {
    const e = setup();
    await e.toMode('llm', 'Keep the staging notes.');
    const release = e.b.holdScans();
    e.file();
    await flush();
    expect(e.b.scans).toEqual(['Keep the staging notes.']);
    e.d.close();
    release();
    await flush();
    expect(e.asks()).toEqual([]);
    // Open, it goes with what was pressed: the candidate it previewed, this dialog's op.
    await e.toMode('llm', 'Keep the staging notes.');
    e.file();
    await flush();
    expect(e.asks()).toEqual([expect.objectContaining({ worker: 'A', mode: 'llm', session: 'sess', candidate: 'cand-1', revision: 'rev-1', instruction: 'Keep the staging notes.' })]);
  });
});

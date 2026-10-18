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

function setup(o: { on?: boolean } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const previews = [PV, AGENT_PV];
  const w = { id: 'A', session: 'herdr-3d', workspace_id: 'w1', label: 'h3d', agent_kind: 'claude', status: 'idle', handoff: CAND } as Worker;
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const store = { floorName: (id: string) => id, workerView: () => ({ name: 'Pixel', desk: 2, harness: 'claude', display: 'idle', worker: w }), workers: new Map([['A', w]]), handoffs, handoffLlm: new HandoffLLMBook(), ai: { state: null } };
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
      if (cmd === 'worker.handoff_preview') return Promise.resolve({ ok: true, data: previews.shift() ?? AGENT_PV });
      if (cmd === 'worker.handoff') return Promise.resolve({ ok: true, data: { request: { op: 'x', state: 'pending', started_at: 1 }, protected: 1 } });
      return Promise.resolve({ ok: true, data: {} });
    },
  };
  const d = new HandoffDialog(document.body, host as never);
  const asks = () => sent.filter((x) => x.cmd === 'worker.handoff').map((x) => x.args);
  const toAgent = async (instruction: string) => {
    d.open('A');
    await flush();
    const r = document.querySelector<HTMLInputElement>('[data-key="mode:agent"]')!;
    r.checked = true;
    r.dispatchEvent(new Event('change'));
    await flush();
    (document.getElementById('ho-instruction') as HTMLTextAreaElement).value = instruction;
  };
  const file = () => document.querySelector<HTMLElement>('.desk-dlg [data-key="file"]')!.click();
  return { b, d, asks, toAgent, file };
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
});

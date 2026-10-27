// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HandoffHire, Worker } from '../net/protocol';
import { flush, installDialogs } from '../test/secretsBridge';
import { HandoffBook } from '../world/handoff';
import { HandoffHireBook } from '../world/handoffHire';
import { HandoffLLMBook } from '../world/handoffLlm';
import { CAT } from '../world/hireReviewFixtures';
import { HandoffDialog } from './handoffDialog';

// #219: the source worker's F dialog shows the hire the bridge makes once its running request is filed, and its
// Cancel request says it cancels the hire too (the bridge cancels both).

const rec = (o: Partial<HandoffHire> = {}): HandoffHire => ({ op: 'ho-1', worker: 'A', worker_name: 'Pixel', mode: 'agent', floor: 'herdr-3d', desk_index: 4, label: 'Nibble', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', state: 'waiting', started_at: 1, ...o });

function setup(running: Partial<Worker>) {
  document.body.replaceChildren();
  const sent: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const w = { id: 'A', session: 'herdr-3d', floor: 'herdr-3d', workspace_id: 'w1', label: 'h3d', agent_kind: 'claude', status: 'idle', ...running } as Worker;
  const workers = new Map([['A', w]]);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const handoffLlm = new HandoffLLMBook();
  handoffLlm.reset({ enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, input_bytes: 98304, max_tokens: 4096, reasoning_effort: '', reasoning: { support: 'unknown', efforts: ['low'], listed: false }, effort_stale: false, timeout_s: 90, prompt_version: 'v1', categories: [] });
  const handoffHires = new HandoffHireBook();
  handoffHires.reset([rec()]);
  const store = { floorName: (id: string) => id, workerView: (id: string) => (workers.get(id) ? { name: 'Pixel', desk: 2, harness: 'claude', display: 'idle', worker: workers.get(id) } : null), workers, handoffs, handoffLlm, handoffHires, hireOptions: CAT, ai: { state: null } };
  const host = {
    store,
    unsupported: () => false,
    toast: () => {},
    now: () => 0,
    copy: async () => true,
    openCabinet: () => {},
    hireFrom: () => {},
    send: (cmd: string, args: Record<string, unknown>): Promise<CommandResult> => {
      sent.push({ cmd, args });
      if (cmd === 'worker.handoff_cancel') return Promise.resolve({ ok: true, data: { op: 'ho-1', state: 'failed', reason: 'cancelled', started_at: 1 } });
      return Promise.resolve({ ok: true, data: {} });
    },
  };
  const d = new HandoffDialog(document.body, host as never);
  return { d, sent, handoffHires };
}

describe('HandoffDialog: a running request’s handoff hire (#219)', () => {
  beforeEach(() => {
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('agent: the callout says who is hired where once it is filed; Cancel request and hire cancels both', async () => {
    const e = setup({ agent_handoff: { op: 'ho-1', state: 'pending', started_at: 1 } });
    e.d.open('A');
    await flush();
    const line = document.querySelector('[data-hook="ho-hire"]');
    expect(line?.textContent).toBe('Then hires Nibble (Claude Code · Opus 5.5 · high) at Desk 5 once it is filed; the desk is held until then. Cancel request cancels the hire too.');
    const btn = document.querySelector<HTMLButtonElement>('[data-key="cancel-request"]')!;
    expect(btn.textContent).toBe('Cancel request and hire');
    expect(btn.title).toBe('Cancels the request and the hire at Desk 5: nothing is filed, nobody is hired');
    btn.click();
    await flush();
    expect(e.sent.filter((x) => x.cmd === 'worker.handoff_cancel').map((x) => x.args)).toEqual([{ worker: 'A', op: 'ho-1' }]);
  });

  it('LLM: the same; the line follows the record (hiring), and goes when it ended', async () => {
    const e = setup({ llm_handoff: { op: 'ho-1', state: 'running', started_at: 1, updated_at: 1 } });
    e.d.open('A');
    await flush();
    expect(document.querySelector('[data-hook="ho-hire"]')?.textContent).toContain('Then hires Nibble');
    expect(document.querySelector('[data-key="cancel-request"]')?.textContent).toBe('Cancel request and hire');
    e.handoffHires.upsert(rec({ state: 'cancelled' }));
    e.d.refresh();
    expect(document.querySelector('[data-hook="ho-hire"]')).toBeNull();
    expect(document.querySelector('[data-key="cancel-request"]')?.textContent).toBe('Cancel request');
  });

  it('no hire for the request: today’s callout and Cancel request', async () => {
    const e = setup({ agent_handoff: { op: 'ho-other', state: 'pending', started_at: 1 } });
    e.d.open('A');
    await flush();
    expect(document.querySelector('[data-hook="ho-hire"]')).toBeNull();
    expect(document.querySelector('[data-key="cancel-request"]')?.textContent).toBe('Cancel request');
  });
});

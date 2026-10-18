// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HireOptions, HirePreset } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { HirePresetBook } from '../world/hirePresets';
import { HirePresetsDialog, type HirePresetsHost } from './hirePresets';
import { STORED_REASON } from './secretsFlow';

// #108 round 4: a hire preset's prompt is stored: reviewed with every match ignored and nothing protectable, and the
// classifier's check (#95) and the save carry that one review; it opens once per text.

const CAT: HireOptions = { codex: { models: ['x-1'], efforts: ['low'] } };
const PROMPT = 'Deploy with TOKEN=ghp_abcdefghijklmnopqrstu1, then spawn a subagent to verify.';

/** `create`: `hire_preset.create`'s refusals in turn (then created). */
function setup(o: { on?: boolean; delegates?: boolean; create?: Array<{ ok: false; code: string; message: string }> } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const refusals = [...(o.create ?? [])];
  const book = new HirePresetBook();
  book.reset([], true);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const host = {
    store: { hirePresets: book, hireOptions: CAT, floorName: (id: string) => id, floorView: () => ({}), ai: { state: { classifier: { state: 'ready' } } } },
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire_preset.check') return { ok: true, data: { delegates: o.delegates === true, score: 0.9 } };
      if (t === 'hire_preset.create') {
        const refused = refusals.shift();
        if (refused) return refused;
        const p = { id: 'hp_1', created_at: 5, updated_at: 5, ...args } as HirePreset;
        book.upsert(p);
        return { ok: true, data: p };
      }
      return { ok: false, code: 'unknown_command', message: '' };
    },
    unsupported: () => false,
    toast: () => {},
    now: () => 0,
    hireAt: vi.fn(),
    use: vi.fn(),
    unsent: vi.fn(() => null),
    secrets: b.flow,
  } as unknown as HirePresetsHost;
  const dlg = new HirePresetsDialog(document.body, host);
  const type = (sel: string, text: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
    el.value = text;
    el.dispatchEvent(new Event('input'));
  };
  const fresh = async (prompt: string) => {
    dlg.open('web', 0);
    (document.querySelector('[data-key="new"]') as HTMLElement).click();
    type('#hp-name', 'Deploy');
    type('#hp-prompt', prompt);
    (document.querySelector('#hp-form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };
  const of = (t: string) => sent.filter((x) => x.t === t).map((x) => x.args);
  return { b, dlg, sent, fresh, of };
}

describe('HirePresetsDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('Save: the stored review first (Protect refused with why), then the check and the save carry it; stored as typed', async () => {
    const e = setup();
    await e.fresh(PROMPT);
    expect(e.b.open()).toMatchObject({ stored: STORED_REASON, action: 'Confirm and save', target: '“Deploy”', counts: { ignore: 1, protect: 0 } });
    expect(e.sent).toEqual([]);
    e.b.confirm();
    await flush();
    const review = { revision: expect.any(String), decisions: [{ candidate: 'c1', action: 'ignore' }] };
    expect(e.of('hire_preset.check')).toEqual([{ prompt: PROMPT, secrets: review }]);
    const [args] = e.of('hire_preset.create');
    expect(args).toMatchObject({ prompt: PROMPT, secrets: review });
    expect(e.b.gate(PROMPT, args!.secrets, 'preset', { stored: true })).toMatchObject({ protected: 0, text: PROMPT });
  });

  it('the check’s question (it starts other agents): answered, the save goes with the same review, no second dialog', async () => {
    const e = setup({ delegates: true });
    await e.fresh(PROMPT);
    e.b.confirm();
    await flush();
    expect(e.of('hire_preset.check')).toHaveLength(1);
    (document.querySelector('[data-key="nudge-on"]') as HTMLElement).click();
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.of('hire_preset.create')).toEqual([expect.objectContaining({ herdr_instructions: true, secrets: e.of('hire_preset.check')[0]!.secrets })]);
    expect(e.b.scans).toHaveLength(1);
  });

  it('Cancel saves nothing and checks nothing; off: no scan, saved as today', async () => {
    const e = setup();
    await e.fresh(PROMPT);
    e.b.cancel();
    await flush();
    expect(e.sent).toEqual([]);
    const off = setup({ on: false });
    await off.fresh(PROMPT);
    expect(off.b.scans).toEqual([]);
    expect(off.of('hire_preset.create')).toEqual([expect.not.objectContaining({ secrets: expect.anything() })]);
  });

  // #108 round 4 fix (D1's audit): closing the dialog leaves the editor's view as it was, so the save's own guard did not
  // see it. Closed while its prompt is scanned, nothing is checked or saved and no review opens.
  it('closed while the prompt is scanned: nothing checked, nothing saved, no review opens', async () => {
    const e = setup();
    const release = e.b.holdScans();
    await e.fresh(PROMPT);
    e.dlg.close();
    release();
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.sent).toEqual([]);
  });

  it('refused as stale, then closed while its prompt is scanned again: saved once, no review opens', async () => {
    const e = setup({ create: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await e.fresh(PROMPT);
    const release = e.b.holdScans();
    e.b.confirm();
    await flush();
    expect(e.of('hire_preset.create')).toHaveLength(1);
    e.dlg.close();
    release();
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.of('hire_preset.create')).toHaveLength(1);
  });
});

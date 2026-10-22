// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexQuestion, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { TranscriptMode } from './transcriptMode';
import { mountTranscript } from './transcriptRender';

// #157: a retry of an async answer against the real store, controller and renderer, fed the way the laptop feeds them
// (laptop/index.ts: the store's latest `codex` once per rendered frame, `codexSeen` skipping an unchanged one). The
// bridge says sending and sent before it acks, and a hidden tab renders no frames while its socket still applies events
// and settles commands, so the card may never see a step: whatever the bridge did between two frames, the card shows
// the state it is given, and an answerable one takes Send again. Only the bridge guards against a duplicate (it marks
// the question sending on the worker's input lane: another answer to it is `stale`), which the card says calmly.

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Sent = { t: string; args: unknown; resolve: (r: CommandResult) => void };

function seat() {
  const store = new WorldStore();
  const layer = document.createElement('div');
  document.body.append(layer);
  const sent: Sent[] = [];
  const status: Array<[string, string | null]> = [];
  const mode = new TranscriptMode({
    send: (t, args) => new Promise<CommandResult>((resolve) => sent.push({ t, args, resolve })),
    feed: () => null,
    renderer: () => Promise.resolve(mountTranscript),
    overlay: () => layer,
    storage: null,
    status: (kind, text) => void status.push([kind, text]),
    modeChanged: () => {},
  });
  const worker = (q: Partial<CodexQuestion>, turn = ''): Worker => ({
    id: 'w',
    session: 's',
    workspace_id: 'ws',
    label: 'Pixel',
    status: 'idle',
    codex: {
      mode: 'shared',
      attached: true,
      thread: 'th1',
      turn,
      questions: [{ batch: 'b', turn: 'old-turn', seen: ['live'], at: 1000, questions: [{ index: 0, title: 'Any context?', state: 'pending', ...q }] }],
    },
  });
  let seq = 0;
  return {
    store,
    sent,
    status,
    answers: () => sent.filter((s) => s.t === 'worker.answer_async'),
    upsert: (q: Partial<CodexQuestion>, turn = '') => store.applyEvent({ t: 'worker.upsert', seq: ++seq, worker: worker(q, turn) }),
    /** A bridge restart's reconnect: the laptop keeps the seated view (its lost-watch sink), so this is only a snapshot. */
    snapshot: (q: Partial<CodexQuestion>) => store.applySnapshot({ t: 'world.snapshot', seq: ++seq, world: { buildings: [], unassigned: [], floors: [], workers: [worker(q)] } }),
    /** A rendered frame: the latest world value, as laptop/index.ts reads it. */
    frame: () => mode.codexSeen(store.workers.get('w')!.codex!, false),
    sit: async () => {
      mode.sit('w', 'Pixel', true, 'codex');
      await flush();
    },
    /** #187: the card is in the questions' sheet, which async questions never open by themselves: the button does. */
    open: () => layer.querySelector<HTMLButtonElement>('.tx-qbtn')!.click(),
    field: () => document.querySelector<HTMLTextAreaElement>('.tx-aq-text')!,
    send: () => document.querySelector<HTMLButtonElement>('.tx-aq .tx-ask-send')!,
    note: () => document.querySelector<HTMLElement>('.tx-aq .tx-ask-note'),
    dispose: () => {
      mode.stand();
      layer.remove();
    },
  };
}

describe('the async card retries what the bridge lets it (#157)', () => {
  let s: ReturnType<typeof seat> | null = null;
  beforeEach(() => {
    // jsdom has no modal dialogs: open / close are what the sheet looks at.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => {
    s?.dispose();
    s = null;
  });

  const write = (x: ReturnType<typeof seat>, text: string) => {
    x.field().value = text;
    x.field().dispatchEvent(new Event('input'));
  };
  const ack = async (x: Sent | undefined, r: CommandResult = { ok: true, data: { state: 'sent', via: 'app_server' } }) => {
    x?.resolve(r);
    await flush();
  };

  for (const back of ['not delivered again', 'pending after a bridge restart'] as const) {
    for (const order of ['the upserts before the ack', 'the ack before the upserts'] as const) {
      it(`${back}, ${order}, all between two rendered frames`, async () => {
        const x = (s = seat());
        const original: Partial<CodexQuestion> = back === 'not delivered again' ? { state: 'sent', undelivered: true, answer: 'Keep v1' } : { state: 'pending' };
        x.upsert(original);
        await x.sit();
        x.frame();
        await flush();
        x.open();
        write(x, 'Keep v1');
        x.send().click();
        x.send().click(); // a double click while it is on its way: one send
        expect(x.answers()).toHaveLength(1);
        expect(x.send().disabled).toBe(true);
        const steps = () => {
          x.upsert({ state: 'sending', answer: 'Keep v1' }, 'new-turn');
          x.upsert({ state: 'sent', answer: 'Keep v1' }, 'new-turn');
          if (back === 'not delivered again') x.upsert(original);
        };
        if (order === 'the upserts before the ack') {
          steps();
          await ack(x.answers()[0]);
        } else {
          await ack(x.answers()[0]);
          steps();
        }
        if (back === 'pending after a bridge restart') x.snapshot(original);
        x.frame();
        await flush();
        // The card shows the state it is given: answerable, the answer kept, Send on.
        expect(x.field().value).toBe('Keep v1');
        expect(x.field().disabled).toBe(false);
        expect(x.send().disabled).toBe(false);
        x.send().click();
        x.send().click();
        expect(x.answers()).toHaveLength(2);
        expect(x.answers()[1]?.args).toEqual({ id: 'w', thread: 'th1', batch: 'b', answers: [{ index: 0, answer: 'Keep v1' }] });
      });
    }
  }

  it('sends the same again once acked while no frame showed the bridge’s step: the bridge refuses it as stale, said calmly', async () => {
    const x = (s = seat());
    x.upsert({ state: 'pending' });
    await x.sit();
    x.frame();
    await flush();
    x.open();
    write(x, 'Keep v1');
    x.send().click();
    x.upsert({ state: 'sending', answer: 'Keep v1' }, 'new-turn');
    x.upsert({ state: 'sent', answer: 'Keep v1' }, 'new-turn');
    await ack(x.answers()[0]);
    // No frame since: the card still shows the question it was given, and a press goes to the bridge.
    expect(x.send().disabled).toBe(false);
    x.send().click();
    expect(x.answers()).toHaveLength(2);
    await ack(x.answers()[1], { ok: false, code: 'stale', message: 'stale: the question is not pending' });
    const note = x.note();
    expect(note?.textContent).toBe('Already sent, answered or hidden — nothing more went to Codex. The card shows where it is now.');
    expect(note?.classList.contains('is-error')).toBe(false);
    expect(note?.getAttribute('role')).toBe('status');
    expect(x.field().value).toBe('Keep v1');
    expect(x.status.filter(([kind]) => kind === 'error')).toEqual([]);
    // The next frame: sent, nothing to send.
    x.frame();
    await flush();
    expect(x.send().disabled).toBe(true);
    expect(document.querySelector('.tx-aq .tx-aq-state')?.textContent).toBe('Sent — Codex will read it with its next step');
  });
});

import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandEntry } from '../net/protocol';
import { CommandCatalogs, RETRY_UNAVAILABLE_MS } from './commandCatalog';

const entry = (name: string, kind: CommandEntry['kind'] = 'command'): CommandEntry => ({ name, description: `${name} it`, argument_hint: '', kind });

/** A bridge the test answers: each ask waits for `answer`. */
function bridge() {
  const asks: { id: string; answer(r: CommandResult): void }[] = [];
  let t = 0;
  const catalogs = new CommandCatalogs({
    send: (_t, args) => new Promise<CommandResult>((resolve) => asks.push({ id: args.id, answer: resolve })),
    now: () => t,
  });
  return {
    catalogs,
    asks,
    advance(ms: number) {
      t += ms;
    },
    async answer(r: CommandResult, i = asks.length - 1) {
      asks[i]?.answer(r);
      await new Promise((res) => setTimeout(res, 0));
    },
  };
}

const ok = (commands: unknown, partial = false): CommandResult => ({ ok: true, data: { commands, partial } });

describe('CommandCatalogs', () => {
  it('starts with no list and loading once asked; the ack is the list', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    expect(w.state).toMatchObject({ commands: null, loading: false, unavailable: false, failed: false, partial: false });
    w.refresh();
    expect(w.state.loading).toBe(true);
    expect(b.asks.map((a) => a.id)).toEqual(['w1']);
    await b.answer(ok([entry('compact'), entry('handoff', 'skill')]));
    expect(w.state).toMatchObject({ loading: false, failed: false, partial: false });
    expect(w.state.commands?.map((c) => c.name)).toEqual(['compact', 'handoff']);
  });

  it('one ask at a time: a refresh while one is out shares it', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    const p1 = w.refresh();
    const p2 = w.refresh();
    expect(p1).toBe(p2);
    expect(b.asks).toHaveLength(1);
    await b.answer(ok([]));
    w.refresh();
    expect(b.asks).toHaveLength(2);
  });

  it('the same worker is the same list (a cache across views); another worker has its own', () => {
    const b = bridge();
    expect(b.catalogs.get('w1')).toBe(b.catalogs.get('w1'));
    expect(b.catalogs.get('w2')).not.toBe(b.catalogs.get('w1'));
  });

  it('a refresh keeps the list it had until the new one comes', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer(ok([entry('a')]));
    w.refresh();
    expect(w.state.commands?.map((c) => c.name)).toEqual(['a']);
    expect(w.state.loading).toBe(true);
    await b.answer(ok([entry('a'), entry('b')]));
    expect(w.state.commands?.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('tells its subscribers when it starts and when it is answered; unsubscribe stops that', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    let n = 0;
    const off = w.subscribe(() => n++);
    w.refresh();
    expect(n).toBe(1);
    await b.answer(ok([]));
    expect(n).toBe(2);
    off();
    w.refresh();
    await b.answer(ok([]));
    expect(n).toBe(2);
  });

  it('partial: the built-ins only', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer(ok([entry('init')], true));
    expect(w.state.partial).toBe(true);
  });

  it('a failed ask keeps the list it had and says it failed; the next one that works clears that', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer({ ok: false, code: 'timeout', message: 'no answer' });
    expect(w.state).toMatchObject({ commands: null, failed: true, loading: false, unavailable: false });
    w.refresh();
    await b.answer(ok([entry('a')]));
    w.refresh();
    await b.answer({ ok: false, code: 'disconnected', message: 'gone' });
    expect(w.state).toMatchObject({ failed: true, loading: false });
    expect(w.state.commands?.map((c) => c.name)).toEqual(['a']);
    w.refresh();
    await b.answer(ok([entry('a')]));
    expect(w.state.failed).toBe(false);
  });

  it('invalid_state or unknown_worker: no list here; asked again only after a while', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer(ok([entry('a')]));
    w.refresh();
    await b.answer({ ok: false, code: 'invalid_state', message: 'runs no Claude or Codex agent' });
    expect(w.state).toMatchObject({ commands: null, unavailable: true, loading: false, failed: false });
    w.refresh();
    expect(b.asks).toHaveLength(2);
    b.advance(RETRY_UNAVAILABLE_MS);
    w.refresh();
    expect(b.asks).toHaveLength(3);
    await b.answer({ ok: false, code: 'unknown_worker', message: 'no such worker' });
    expect(w.state.unavailable).toBe(true);
    b.advance(RETRY_UNAVAILABLE_MS);
    w.refresh();
    await b.answer(ok([entry('b')]));
    expect(w.state).toMatchObject({ unavailable: false });
  });

  it('a send that throws is a failure, not stuck loading', async () => {
    const catalogs = new CommandCatalogs({ send: () => Promise.reject(new Error('boom')) });
    const w = catalogs.get('w1');
    await w.refresh();
    expect(w.state).toMatchObject({ loading: false, failed: true });
  });

  it('keeps only well-formed rows from the bridge: a name, strings, a known kind (else a skill), no leading slash', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer(
      ok([
        entry('a'),
        { name: '/b', description: 3, argument_hint: null, kind: 'weird' },
        { name: '', description: 'x', argument_hint: '', kind: 'command' },
        null,
        'c',
        { name: 'has space', description: '', argument_hint: '', kind: 'command' },
        { name: 'd', description: 'line one\nline two', argument_hint: '<x>', kind: 'custom' },
      ]),
    );
    expect(w.state.commands).toEqual([
      entry('a'),
      { name: 'b', description: '', argument_hint: '', kind: 'skill' },
      { name: 'd', description: 'line one\nline two', argument_hint: '<x>', kind: 'custom' },
    ]);
  });

  it('an ack without a list is a failure', async () => {
    const b = bridge();
    const w = b.catalogs.get('w1');
    w.refresh();
    await b.answer({ ok: true, data: { partial: false } });
    expect(w.state).toMatchObject({ commands: null, failed: true });
  });
});

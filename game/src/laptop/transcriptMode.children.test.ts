import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TranscriptChild, TranscriptItem } from '../net/protocol';
import { childEndText, TranscriptMode, type ChildInfo, type MountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptMode';
import { childEmptyText, type ChildViewState } from './transcriptChild';
import { watchAck } from './transcriptWatches';

// #26: a native child's conversation over its worker's, in the seated view's controller (no DOM: fake panes and views).

const item = (id: string, seq = 1): TranscriptItem => ({ id, seq, ts: 0, kind: 'assistant', parts: [{ text: id }] });

class Pane {
  hidden = false;
  removed = false;
  focused = 0;
  style: Record<string, string> = {};
  remove(): void {
    this.removed = true;
  }
  focus(): void {
    this.focused++;
  }
}

class View {
  calls: string[] = [];
  child: ChildViewState[] = [];
  destroyed = false;
  focused = 0;
  constructor(
    readonly host: TranscriptRenderHost,
    readonly pane: Pane,
  ) {}
  setItems(items: TranscriptItem[]): void {
    this.calls.push(`set ${items.map((i) => i.id).join(',')}`);
  }
  applyUpdates(items: TranscriptItem[]): void {
    this.calls.push(`apply ${items.map((i) => i.id).join(',')}`);
  }
  setChild(s: ChildViewState): void {
    this.child.push(s);
  }
  focus(): void {
    this.focused++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function rig() {
  const views: View[] = [];
  const panes: Pane[] = [];
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const status: Array<[string, string | null]> = [];
  let changed = 0;
  const mount: MountTranscript = (pane, host) => {
    const v = new View(host, pane as unknown as Pane);
    views.push(v);
    return v as unknown as TranscriptView;
  };
  const tx = new TranscriptMode({
    feed: () => null,
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    renderer: () => Promise.resolve(mount),
    overlay: () => new Pane() as unknown as HTMLElement,
    pane: () => {
      const p = new Pane();
      panes.push(p);
      return p as unknown as HTMLElement;
    },
    storage: null,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: () => {},
    childChanged: () => changed++,
  });
  tx.place({ left: 0, top: 0, width: 800, height: 600 });
  return { tx, views, panes, sent, status, changed: () => changed };
}

const ada: TranscriptChild = { id: 'ch_ada', generation: 7, provider: 'codex' };
const info = (o: Partial<ChildInfo> = {}): ChildInfo => ({ name: 'Ada', type: 'worker', description: 'Find the GPU flags', state: 'running', since: 'running 4m', ...o });

describe('TranscriptMode: a child’s conversation (#26)', () => {
  it('opens over the worker’s, read only, with its breadcrumb; back shows the worker’s view as it was', async () => {
    const r = rig();
    r.tx.sit('w1', 'Nibble');
    await flush();
    const parent = r.views[0] as View;
    r.tx.reset('w1', watchAck({ harness: 'codex', session: 's', cursor: 'c:40', has_more: true, items: [item('p1', 40), item('p2', 41)] }));
    expect(parent.calls).toEqual(['set ', 'set p1,p2']);

    r.tx.openChild(ada, info());
    await flush();
    expect(r.changed()).toBe(1);
    expect(r.tx.child).toEqual(ada);
    const child = r.views[1] as View;
    expect(child.host.child).toMatchObject({ worker: 'Nibble', name: 'Ada', type: 'worker', description: 'Find the GPU flags' });
    expect(parent.pane.hidden).toBe(true);
    expect(child.pane.hidden).toBe(false);
    expect(child.child.at(-1)).toEqual({ state: 'running', since: 'running 4m', availability: null, hasMore: false });
    // Nothing goes to the worker from it.
    await expect(Promise.resolve(child.host.onPromptSubmit('hi'))).resolves.toBe(false);
    expect(r.sent).toEqual([]);

    // The child's watch feeds the child's view only; the worker's goes on feeding its own, hidden.
    r.tx.resetChild('w1', ada, watchAck({ harness: 'codex', session: 'th', cursor: 'c:3', has_more: true, availability: 'available', items: [item('c3', 3)] }));
    r.tx.pushChild('w1', ada, [item('c4', 4)], []);
    r.tx.push('w1', [item('p3', 42)], []);
    expect(child.calls).toEqual(['set ', 'set c3', 'apply c4']);
    expect(parent.calls).toEqual(['set ', 'set p1,p2', 'apply p3']);
    expect(r.tx.childState).toEqual({ id: 'ch_ada', items: 2, availability: 'available', hasMore: true, mounted: true });

    // Older items of the child: its own target and cursor.
    const older = child.host.child?.loadOlder();
    expect(r.sent.at(-1)?.args).toEqual({ id: 'w1', before: 'c:3', limit: 200, child: ada });
    r.sent.at(-1)?.resolve({ ok: true, data: { items: [item('c1', 1), item('c2', 2)], cursor: 'c:1', has_more: false } });
    await older;
    expect(child.calls.at(-1)).toBe('set c1,c2,c3,c4');
    expect(child.child.at(-1)?.hasMore).toBe(false);

    // Back: the child's view goes; the worker's is the same view, never reset meanwhile, on screen again.
    expect(r.tx.closeChild()).toBe(true);
    expect(child.destroyed).toBe(true);
    expect(child.pane.removed).toBe(true);
    expect(parent.destroyed).toBe(false);
    expect(parent.pane.hidden).toBe(false);
    expect(parent.calls).toEqual(['set ', 'set p1,p2', 'apply p3']);
    expect(r.tx.child).toBeNull();
    expect(r.changed()).toBe(2);
    expect(r.tx.closeChild()).toBe(false); // the next Esc stands you up
  });

  it('a late ack or push for another child or generation is dropped; another child replaces the open one', async () => {
    const r = rig();
    r.tx.sit('w1', 'Nibble');
    r.tx.openChild(ada, info());
    await flush();
    const child = r.views.at(-1) as View;
    r.tx.resetChild('w1', { ...ada, generation: 6 }, watchAck({ items: [item('old')] }));
    r.tx.pushChild('w1', { ...ada, id: 'ch_bell' }, [item('bell')], []);
    r.tx.resetChild('w2', ada, watchAck({ items: [item('other')] }));
    expect(child.calls).toEqual(['set ']);
    const bell = { ...ada, id: 'ch_bell' };
    r.tx.openChild(bell, info({ name: 'Bell' }));
    await flush();
    expect(child.destroyed).toBe(true);
    expect(r.tx.child).toEqual(bell);
    expect((r.views.at(-1) as View).host.child?.name).toBe('Bell');
  });

  it('pending, then unavailable by a head alone, then live with its cursor', async () => {
    const r = rig();
    r.tx.sit('w1', 'Nibble');
    r.tx.openChild(ada, info());
    await flush();
    const child = r.views.at(-1) as View;
    r.tx.resetChild('w1', ada, watchAck({ harness: 'codex', session: '', pending: true, availability: 'pending', items: [] }));
    expect(child.child.at(-1)?.availability).toBe('pending');
    r.tx.pushChild('w1', ada, [], [], { harness: 'codex', session: '', pending: true, availability: 'unavailable' });
    expect(child.child.at(-1)?.availability).toBe('unavailable');
    r.tx.pushChild('w1', ada, [item('c9', 9)], [], { harness: 'codex', session: 'th', pending: false, availability: 'available', cursor: 'c:9', has_more: true });
    expect(child.child.at(-1)).toMatchObject({ availability: 'available', hasMore: true });
    expect(r.tx.childState?.items).toBe(1);
    // Its state from the store: drawn when it changes.
    r.tx.childSeen(info({ state: 'completed', since: 'completed in 5m' }));
    expect(child.child.at(-1)).toMatchObject({ state: 'completed', since: 'completed in 5m' });
  });

  it('the worker’s session replaced while a child is open: back to the worker’s view, and the bar says why', async () => {
    const r = rig();
    r.tx.sit('w1', 'Nibble');
    r.tx.openChild(ada, info());
    await flush();
    expect(r.tx.closeChild(childEndText('session_changed', 'Nibble'))).toBe(true);
    expect(r.status.at(-1)).toEqual(['ok', 'Nibble started a new session: its subagents went with the old one']);
    expect(r.tx.child).toBeNull();
    // Standing up drops it too.
    r.tx.openChild(ada, info());
    await flush();
    const child = r.views.at(-1) as View;
    r.tx.stand();
    expect(child.destroyed).toBe(true);
  });

  it('the images tab and the terminal keep the child open underneath; Ctrl+Esc comes back to it', async () => {
    const r = rig();
    r.tx.sit('w1', 'Nibble');
    r.tx.openChild(ada, info());
    await flush();
    const child = r.views.at(-1) as View;
    r.tx.setMode('terminal');
    r.tx.toggle();
    await flush();
    expect(r.tx.mode).toBe('transcript');
    expect(child.destroyed).toBe(false);
    expect(child.pane.hidden).toBe(false);
  });
});

describe('the child view’s words (#26)', () => {
  it('says why there is nothing to read', () => {
    expect(childEmptyText('Ada', 'Nibble', null).title).toBe('Opening Ada’s conversation…');
    expect(childEmptyText('Ada', 'Nibble', 'pending')).toEqual({ title: 'Ada hasn’t written anything yet', body: 'Its conversation shows here as soon as it starts. You can stay on this page.' });
    expect(childEmptyText('Ada', 'Nibble', 'unavailable')).toEqual({
      title: 'Ada has no conversation to show',
      body: 'Its log was never kept, or it was cleaned up. Nibble’s own conversation still has the call that started it.',
    });
  });

  it('says why a child’s conversation ended, without error codes', () => {
    expect(childEndText('stale', 'Nibble')).toEqual({ kind: 'ok', text: 'Nibble started a new session: its subagents went with the old one' });
    expect(childEndText('not_found', 'Nibble')).toEqual({ kind: 'ok', text: 'That subagent is no longer listed: back to Nibble’s conversation' });
    expect(childEndText('bad_request', 'Nibble')?.text).toContain('Update the bridge');
    expect(childEndText('capacity', 'Nibble')?.kind).toBe('error');
    expect(childEndText('worker_removed', 'Nibble')).toBeNull();
    expect(childEndText('evicted', 'Nibble')).toBeNull();
  });
});

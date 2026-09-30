import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Question, TranscriptItem } from '../net/protocol';
import { subagentItems, TranscriptMode, type MountTranscript, type SeatMode, type TranscriptRenderHost } from './transcriptMode';
import { TranscriptWatches, watchAck } from './transcriptWatches';

const item = (id: string, seq = 1, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, seq, ts: 0, kind: 'assistant', parts: [{ text: id }], ...extra });

/** A DOM element as far as the controller uses it (the tests run without a DOM). */
class FakeBox {
  hidden = false;
  focused = 0;
  style: Record<string, string> = {};
  constructor(private readonly layer: FakeBox[]) {
    layer.push(this);
  }
  remove(): void {
    const i = this.layer.indexOf(this);
    if (i >= 0) this.layer.splice(i, 1);
  }
  focus(): void {
    this.focused++;
  }
}

class FakeView {
  calls: string[] = [];
  destroyed = false;
  constructor(readonly host: TranscriptRenderHost) {}
  setItems(items: TranscriptItem[]): void {
    this.calls.push(`set ${items.map((i) => i.id).join(',')}`);
  }
  applyUpdates(items: TranscriptItem[]): void {
    this.calls.push(`apply ${items.map((i) => i.id).join(',')}`);
  }
  setBlocked(q: Question | null): void {
    this.calls.push(`blocked ${q?.hash ?? 'null'}`);
  }
  focused = 0;
  focus(): void {
    this.focused++;
  }
  focusPrompt(): void {
    this.calls.push('prompt');
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

function harness(o: { storage?: unknown; renderer?: () => Promise<MountTranscript | null> } = {}) {
  const layer: FakeBox[] = [];
  const views: FakeView[] = [];
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const status: Array<[string, string | null]> = [];
  const modes: SeatMode[] = [];
  const mount: MountTranscript = (_box, host) => {
    const v = new FakeView(host);
    views.push(v);
    return v;
  };
  const storage = (o.storage ?? new MemStorage()) as Storage;
  const tx = new TranscriptMode({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    renderer: o.renderer ?? (() => Promise.resolve(mount)),
    overlay: () => new FakeBox(layer) as unknown as HTMLElement,
    storage,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: (m) => modes.push(m),
  });
  return { tx, layer, views, sent, status, modes, storage, mount };
}

const ack = (items: TranscriptItem[]) => watchAck({ harness: 'claude', session: 's', cursor: 'c:1', items });

describe('TranscriptMode', () => {
  it('keeps the transcript from the moment you sit; the first switch mounts the view with it', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('terminal');
    expect(h.layer).toHaveLength(0);
    h.tx.reset('a', ack([item('x1'), item('x2', 2)]));
    h.tx.push('a', [item('x3', 3)], [item('x1', 1, { kind: 'tool' })]);
    h.tx.push('b', [item('other')], []); // not the worker you sit at
    h.tx.toggle();
    expect(h.tx.mode).toBe('transcript');
    expect(h.modes).toEqual(['terminal', 'transcript']);
    expect(h.layer).toHaveLength(1);
    await flush();
    expect(h.views).toHaveLength(1);
    expect(h.views[0]?.calls).toEqual(['set x1,x2,x3']);
    // The keyboard goes to the view's timeline (its scroll keys), not just the overlay around it; while the overlay
    // is not placed yet (invisible: a browser ignores focus there) it waits for the first place().
    expect(h.views[0]?.focused).toBe(0);
    h.tx.place({ left: 10, top: 80, width: 800, height: 500 });
    expect(h.views[0]?.focused).toBe(1);
    expect(h.layer[0]?.focused).toBe(0);
    // Only once: moving the overlay does not take the keyboard back.
    h.tx.place({ left: 12, top: 80, width: 800, height: 500 });
    expect(h.views[0]?.focused).toBe(1);
    // Live: new items and updates go through applyUpdates, both upserted by id.
    h.tx.push('a', [item('x4', 4)], [item('x3', 3, { kind: 'tool' })]);
    expect(h.views[0]?.calls.at(-1)).toBe('apply x4,x3');
    expect(h.tx.itemCount).toBe(4);
  });

  it('back to the terminal hides the overlay and keeps the view; switching again shows it at once', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    await flush();
    h.tx.toggle();
    expect(h.tx.shown).toBe(false);
    expect(h.layer[0]?.hidden).toBe(true);
    h.tx.toggle();
    expect(h.layer[0]?.hidden).toBe(false);
    expect(h.views).toHaveLength(1);
    expect(h.layer).toHaveLength(1);
  });

  it('a re-watch (session_changed) replaces what the view shows', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', ack([item('old')]));
    h.tx.toggle();
    await flush();
    h.tx.reset('a', ack([item('new1'), item('new2', 2)]));
    expect(h.views[0]?.calls).toEqual(['set old', 'set new1,new2']);
    h.tx.push('a', [item('old')], []); // an id from the old session is new here
    expect(h.tx.itemCount).toBe(3);
  });

  it('the blocked question reaches the view once per change, and on mount', async () => {
    const h = harness();
    const q: Question = { kind: 'permission', text: 'Allow?', excerpt: ['x'], choices: [{ n: 1, label: 'Yes' }], hash: 'h1' };
    h.tx.sit('a', 'Ada');
    h.tx.blocked(q);
    h.tx.toggle();
    await flush();
    h.tx.blocked({ ...q });
    h.tx.blocked({ ...q, selected: 1 });
    h.tx.blocked(null);
    h.tx.blocked(null);
    expect(h.views[0]?.calls.filter((c) => c.startsWith('blocked'))).toEqual(['blocked h1', 'blocked h1', 'blocked null']);
  });

  it('wires prompts, answers, the switch back and subagents to the bridge', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    await flush();
    const host = (h.views[0] as FakeView).host;
    const sentOk = host.onPromptSubmit('fix the test');
    await expect(host.onPromptSubmit('   ')).resolves.toBe(false);
    host.onAnswer('h1', 2);
    host.onAnswer('h1', null, true);
    host.onAnswer('h1', null);
    const sub = host.loadSubagent('a7');
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([
      ['worker.prompt', { id: 'a', text: 'fix the test' }],
      ['worker.answer', { id: 'a', hash: 'h1', choice: 2 }],
      ['worker.answer', { id: 'a', hash: 'h1', cancel: true }],
      // A subagent's own timeline is a page of it (transcript.item is one item by its item id).
      ['transcript.page', { id: 'a', before: '', agent: 'a7', limit: 500 }],
    ]);
    h.sent[0]?.resolve({ ok: true, data: { sent: 'prompt' } });
    h.sent[1]?.resolve({ ok: false, code: 'stale_question', message: 'the question changed' });
    h.sent[3]?.resolve({ ok: true, data: { items: [item('s1'), item('s2', 2)], cursor: 'c:1', has_more: false } });
    expect((await sub).map((i) => i.id)).toEqual(['s1', 's2']);
    await flush();
    await expect(sentOk).resolves.toBe(true);
    expect(h.status[0]).toEqual(['ok', 'Sent to Ada']);
    expect(h.status[1]?.[0]).toBe('error');
    host.onSwitchToTerminal();
    expect(h.tx.mode).toBe('terminal');
    h.tx.toggle();
    h.tx.focusPrompt();
    expect(h.views[0]?.calls.at(-1)).toBe('prompt');
  });

  it('reads a subagent from its page ack; a failed load throws for the view to show', async () => {
    expect(subagentItems({ items: [item('a'), { junk: true }], cursor: 'c:1', has_more: false }).map((i) => i.id)).toEqual(['a']);
    expect(subagentItems({ item: item('b') })).toEqual([]);
    expect(subagentItems(null)).toEqual([]);
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    await flush();
    const sub = (h.views[0] as FakeView).host.loadSubagent('a7');
    h.sent[0]?.resolve({ ok: false, code: 'not_found', message: 'no transcript for subagent "a7"' });
    await expect(sub).rejects.toThrow();
  });

  it('remembers the mode per worker; blocked storage breaks nothing', () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    h.tx.sit('b', 'Bo');
    expect(h.tx.mode).toBe('terminal');
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    // Not while the bridge has no transcripts.
    h.tx.sit('a', 'Ada', false);
    expect(h.tx.mode).toBe('terminal');
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('terminal');
    // A new page (a new controller) reads the same storage.
    const again = harness({ storage: h.storage });
    again.tx.sit('a', 'Ada');
    expect(again.tx.mode).toBe('terminal');
    h.tx.toggle();
    const third = harness({ storage: h.storage });
    third.tx.sit('a', 'Ada');
    expect(third.tx.mode).toBe('transcript');

    const b = harness({ storage: throwing });
    b.tx.sit('a', 'Ada');
    b.tx.toggle();
    expect(b.tx.mode).toBe('transcript');
    b.tx.sit('a', 'Ada');
    expect(b.tx.mode).toBe('terminal');
  });

  it('a build without the render module falls back to the terminal and says so', async () => {
    const h = harness({ renderer: () => Promise.resolve(null) });
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    await flush();
    expect(h.tx.mode).toBe('terminal');
    expect(h.status.at(-1)?.[0]).toBe('error');
  });

  it('the watch ending for good (worker_removed, asleep) goes back to the terminal', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    await flush();
    h.tx.stop('b');
    expect(h.tx.mode).toBe('transcript');
    h.tx.stop('a');
    expect(h.tx.mode).toBe('terminal');
  });

  it('standing up while the render module loads mounts nothing', async () => {
    let done: (m: MountTranscript) => void = () => {};
    const h = harness({ renderer: () => new Promise((r) => (done = r)) });
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    h.tx.stand();
    done(h.mount);
    await flush();
    expect(h.views).toHaveLength(0);
    expect(h.layer).toHaveLength(0);
    // Sitting again while an older load is on its way: only the new seat's view mounts.
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    done(h.mount);
    await flush();
    expect(h.views).toHaveLength(1);
  });

  it('places the overlay over the monitor, hidden while it is off the view', () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    h.tx.place({ left: 10, top: 80, width: 900, height: 560 });
    const box = h.layer[0] as FakeBox;
    expect(box.style).toMatchObject({ left: '10px', top: '80px', width: '900px', height: '560px', visibility: '' });
    h.tx.place(null);
    expect(box.style.visibility).toBe('hidden');
  });
});

describe('sit / toggle / stand cycles', () => {
  it('20 cycles leave no transcript watches, views or overlays behind', async () => {
    const h = harness();
    const wsent: Array<{ t: string; id: string; resolve: (r: CommandResult) => void }> = [];
    let now = 0;
    const tw = new TranscriptWatches({
      send: (t, args) => new Promise((resolve) => wsent.push({ t, id: args.id, resolve })),
      sink: { reset: (id, a) => h.tx.reset(id, a), push: (id, i, u) => h.tx.push(id, i, u), stop: () => {} },
      failed: () => {},
      closed: () => {},
      now: () => now,
    });
    for (let i = 0; i < 20; i++) {
      const id = `w${i % 3}`;
      // Sit (as Laptops.sit does): the controller, then the watch.
      h.tx.sit(id, 'Ada');
      tw.sync(new Set([id]));
      const w = wsent.at(-1);
      expect(w?.t).toBe('transcript.watch');
      // Some acks come before the switch, some after, some never (stood up first).
      if (i % 3 === 0) w?.resolve({ ok: true, data: { items: [item(`i${i}`)] } });
      await flush();
      tw.items({ t: 'transcript.items', id, items: [item(`p${i}`, 2)], updates: [] });
      if (h.tx.mode === 'terminal') h.tx.toggle();
      if (i % 3 === 1) w?.resolve({ ok: true, data: { items: [] } });
      await flush();
      if (i % 2) h.tx.toggle();
      if (i % 5 === 0) {
        // A session change mid-read: the watch comes back with the new session.
        now += 5000;
        tw.closed({ t: 'transcript.closed', id, reason: 'session_changed' });
        wsent.at(-1)?.resolve({ ok: true, data: { items: [item(`n${i}`)] } });
        await flush();
      }
      // Stand (as Laptops.stand does).
      h.tx.stand();
      tw.sync(new Set());
      await flush();
      expect(tw.count).toBe(0);
      expect(h.layer).toHaveLength(0);
      expect(h.tx.seated).toBeNull();
    }
    const watches = wsent.filter((s) => s.t === 'transcript.watch').length;
    const unwatches = wsent.filter((s) => s.t === 'transcript.unwatch').length;
    // Each sit watched once (plus the session changes' re-watches, which the bridge closed itself); each stand unwatched.
    expect(unwatches).toBe(20);
    expect(watches).toBe(20 + 4);
    expect(h.tx.counts.overlays).toBe(h.tx.counts.removed);
    expect(h.tx.counts.mounted).toBe(h.tx.counts.destroyed);
    expect(h.views.every((v) => v.destroyed)).toBe(true);
    expect(h.views.length).toBeGreaterThan(0);
  });
});

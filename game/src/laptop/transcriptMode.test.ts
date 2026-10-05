import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Ask, Followup, Question, TranscriptItem, Usage } from '../net/protocol';
import { ImageFeed } from './imageFeed';
import { hasTranscript, subagentItems, TranscriptMode, type MountTranscript, type SeatMode, type TranscriptRenderHost } from './transcriptMode';
import { TranscriptWatches, watchAck } from './transcriptWatches';
import { activityCue, promptKey, reconcile, SENT_TIMEOUT_MS, type ActivityCue, type PendingPrompt } from './transcriptActivity';

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
  setAsk(a: Ask | null): void {
    this.calls.push(`ask ${a?.tool_use_id ?? 'null'}`);
  }
  setFollowup(f: Followup | null): void {
    this.calls.push(`followup ${f?.turn_id ?? 'null'}`);
  }
  setUsage(u: Usage | null): void {
    this.calls.push(`usage ${u?.context_pct ?? 'null'}`);
  }
  cues: Array<ActivityCue | null> = [];
  setActivity(c: ActivityCue | null): void {
    this.cues.push(c);
  }
  pending: Array<readonly PendingPrompt[]> = [];
  setPending(rows: readonly PendingPrompt[]): void {
    this.pending.push(rows);
  }
  attachTabs(): void {}
  hasItem(): boolean {
    return false;
  }
  scrollToItem(): boolean {
    return false;
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

function harness(o: { storage?: unknown; renderer?: () => Promise<MountTranscript | null>; feed?: ImageFeed } = {}) {
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
  const clock = { t: 1_000_000 };
  const tx = new TranscriptMode({
    now: () => clock.t,
    feed: () => o.feed ?? null,
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    renderer: o.renderer ?? (() => Promise.resolve(mount)),
    overlay: () => new FakeBox(layer) as unknown as HTMLElement,
    storage,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: (m) => modes.push(m),
  });
  return { tx, layer, views, sent, status, modes, storage, mount, clock };
}

const ack = (items: TranscriptItem[]) => watchAck({ harness: 'claude', session: 's', cursor: 'c:1', items });

describe('TranscriptMode', () => {
  it('opens the conversation as you sit (#98); the view mounts with what the watch sent meanwhile', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    expect(h.modes).toEqual(['transcript']);
    expect(h.layer).toHaveLength(1);
    h.tx.reset('a', ack([item('x1'), item('x2', 2)]));
    h.tx.push('a', [item('x3', 3)], [item('x1', 1, { kind: 'tool' })]);
    h.tx.push('b', [item('other')], []); // not the worker you sit at
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
    await flush();
    h.tx.blocked({ ...q });
    h.tx.blocked({ ...q, selected: 1 });
    h.tx.blocked(null);
    h.tx.blocked(null);
    expect(h.views[0]?.calls.filter((c) => c.startsWith('blocked'))).toEqual(['blocked h1', 'blocked h1', 'blocked null']);
  });

  it('#101: the usage reaches the view once per change; one that came before the view loaded is on the host it mounts with', async () => {
    const u = (pct: number | null, extra: Partial<Usage> = {}): Usage => ({
      tokens: 1, cost_usd_est: 0, priced: 'known', model: 'claude-opus-5-5', context_pct: pct, context_window: 1_000_000, context_tokens: 10_000, ...extra,
    });
    const h = harness();
    h.tx.usageSeen(u(1)); // nobody sits: nothing to keep
    h.tx.sit('a', 'Ada');
    h.tx.usageSeen(u(4.2)); // the view is still loading
    h.tx.usageSeen(u(4.2));
    await flush();
    const view = h.views[0] as FakeView;
    expect(view.host.usage).toEqual(u(4.2));
    expect(view.calls.filter((c) => c.startsWith('usage'))).toEqual([]);
    // The same usage again (a frame): nothing. The store replaces the worker's usage on a change: a new object, same values: nothing.
    h.tx.usageSeen(u(4.2));
    h.tx.usageSeen({ ...u(4.2) });
    expect(view.calls.filter((c) => c.startsWith('usage'))).toEqual([]);
    // A new count, or the window's flag, alone is a change; so is a compact dropping the share (null).
    h.tx.usageSeen(u(4.2, { context_tokens: 10_400 }));
    h.tx.usageSeen(u(4.2, { context_tokens: 10_400, context_window_estimated: true }));
    h.tx.usageSeen(u(null, { context_tokens: 0 }));
    h.tx.usageSeen(null);
    expect(view.calls.filter((c) => c.startsWith('usage'))).toEqual(['usage 4.2', 'usage 4.2', 'usage null', 'usage null']);
    // It survives the terminal and the conversation toggling (the view is kept).
    h.tx.usageSeen(u(30));
    h.tx.toggle();
    h.tx.toggle();
    expect(h.views).toHaveLength(1);
    expect(view.calls.at(-1)).toBe('usage 30');
    // Another seat starts without it.
    h.tx.sit('b', 'Bo');
    await flush();
    expect((h.views[1] as FakeView).host.usage).toBeNull();
  });

  it('wires prompts, answers, the switch back and subagents to the bridge', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
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
    await flush();
    const sub = (h.views[0] as FakeView).host.loadSubagent('a7');
    h.sent[0]?.resolve({ ok: false, code: 'not_found', message: 'no transcript for subagent "a7"' });
    await expect(sub).rejects.toThrow();
  });

  it("a subagent's images are noted with its agent id: fetchable, read from its log", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const feed = new ImageFeed('a', {
      send: (_t, args) => {
        asked.push(args as unknown as Record<string, unknown>);
        return Promise.resolve<CommandResult>({ ok: true, data: { mime: 'image/png', width: 1, height: 1, bytes: 3, size: 'thumb', data: btoa('abc') } });
      },
    });
    URL.createObjectURL = () => 'blob:sub';
    const h = harness({ feed });
    h.tx.sit('a', 'Ada');
    await flush();
    const image = { source: 'path', origin: 'agent', kind: 'viewed', hash: 'e'.repeat(64), mime: 'image/png', path: '/w/shot.png' } as const;
    const sub = (h.views[0] as FakeView).host.loadSubagent('a7');
    expect(feed.canFetch(image)).toBe(false);
    h.sent[0]?.resolve({ ok: true, data: { items: [item('s1', 1, { kind: 'tool', tool: { name: 'Read', input_summary: '', status: 'ok', images: [{ image }] } })], cursor: 'c:1', has_more: false } });
    await sub;
    expect(feed.canFetch(image)).toBe(true);
    await feed.thumb(image.hash);
    expect(asked.at(-1)).toMatchObject({ id: 'a', hash: image.hash, size: 'thumb', agent: 'a7' });
  });

  it('remembers who you left in the terminal; the conversation for everyone else; blocked storage breaks nothing', () => {
    const h = harness();
    // Never seen: the conversation (#98).
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    h.tx.toggle(); // left in the terminal
    h.tx.sit('b', 'Bo');
    expect(h.tx.mode).toBe('transcript');
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('terminal');
    expect(JSON.parse(h.storage.getItem('h3d.seat.terminal') ?? '[]')).toEqual(['a']);
    // No transcript to read (the bridge has none, the harness writes none): the terminal, and nothing remembered for it.
    h.tx.sit('b', 'Bo', false);
    expect(h.tx.mode).toBe('terminal');
    expect(h.modes.at(-1)).toBe('terminal');
    h.tx.sit('b', 'Bo');
    expect(h.tx.mode).toBe('transcript');
    // Back to the conversation: remembered too.
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    expect(h.storage.getItem('h3d.seat.terminal')).toBeNull();
    // A new page (a new controller) reads the same storage.
    h.tx.toggle();
    const again = harness({ storage: h.storage });
    again.tx.sit('a', 'Ada');
    expect(again.tx.mode).toBe('terminal');
    h.tx.toggle();
    const third = harness({ storage: h.storage });
    third.tx.sit('a', 'Ada');
    expect(third.tx.mode).toBe('transcript');

    const b = harness({ storage: throwing });
    b.tx.sit('a', 'Ada');
    expect(b.tx.mode).toBe('transcript');
    b.tx.toggle();
    expect(b.tx.mode).toBe('terminal');
    b.tx.sit('a', 'Ada');
    expect(b.tx.mode).toBe('transcript');
  });

  it('only Claude Code and Codex write a transcript to sit down to (#98)', () => {
    expect(['claude', 'codex', 'pi', '', undefined].map(hasTranscript)).toEqual([true, true, false, false, false]);
  });

  it('ignores the list of before #98 (who was read in transcript mode), and removes it', () => {
    const storage = new MemStorage();
    storage.setItem('h3d.seat.transcript', JSON.stringify(['a', 'b']));
    storage.setItem('h3d.seat.images', JSON.stringify(['b']));
    const h = harness({ storage });
    h.tx.sit('c', 'Cy');
    expect(h.tx.mode).toBe('transcript');
    expect(storage.getItem('h3d.seat.transcript')).toBeNull();
    // Whoever was not in it was in the terminal then: the conversation now all the same.
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    expect(storage.getItem('h3d.seat.terminal')).toBeNull();
  });

  it('a build without the render module falls back to the terminal and says so', async () => {
    const h = harness({ renderer: () => Promise.resolve(null) });
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('transcript');
    await flush();
    expect(h.tx.mode).toBe('terminal');
    expect(h.status.at(-1)?.[0]).toBe('error');
    // Not a choice of yours: the next sit tries the conversation again.
    expect(h.storage.getItem('h3d.seat.terminal')).toBeNull();
  });

  it('the watch ending for good (worker_removed, asleep) goes back to the terminal', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    await flush();
    h.tx.stop('b');
    expect(h.tx.mode).toBe('transcript');
    h.tx.stop('a');
    expect(h.tx.mode).toBe('terminal');
    expect(h.storage.getItem('h3d.seat.terminal')).toBeNull();
  });

  it('standing up while the render module loads mounts nothing', async () => {
    let done: (m: MountTranscript) => void = () => {};
    const h = harness({ renderer: () => new Promise((r) => (done = r)) });
    h.tx.sit('a', 'Ada');
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

// #58: what the agent is doing (the spike's table, docs/research/transcript-activity.md) and the prompts on their way.
describe('the live cue', () => {
  const user = (id: string, seq: number, text = id) => item(id, seq, { kind: 'user', parts: [{ text }] });
  const tool = (id: string, seq: number, status: 'running' | 'ok' | 'error' | 'interrupted') => item(id, seq, { kind: 'tool', tool: { name: 'Bash', input_summary: '', status } });
  const sub = (id: string, seq: number, status: string) => item(id, seq, { kind: 'subagent', subagent: { agent_id: '', description: 'd', status } });
  const cue = (items: TranscriptItem[], mark: number | null = 0, status = 'working') => activityCue(items, status, 500, mark)?.kind ?? null;

  it('says nothing unless the worker is working', () => {
    for (const st of ['idle', 'done', 'blocked', 'unknown', '']) expect(cue([user('u', 1)], 0, st)).toBeNull();
  });

  it('maps the current turn’s last meaningful item', () => {
    expect(cue([])).toBe('thinking');
    expect(cue([user('u', 1)])).toBe('thinking');
    expect(cue([user('u', 1), item('t', 2, { kind: 'thinking' })])).toBe('thinking');
    for (const st of ['ok', 'error', 'interrupted'] as const) expect(cue([user('u', 1), tool('b', 2, st)])).toBe('thinking');
    expect(cue([user('u', 1), item('a', 2)])).toBe('working');
    // A running tool or synchronous subagent speaks for itself: no cue under it.
    expect(cue([user('u', 1), tool('b', 2, 'running')])).toBeNull();
    expect(cue([user('u', 1), sub('s', 2, 'running')])).toBeNull();
    expect(cue([user('u', 1), sub('s', 2, 'completed')])).toBe('thinking');
    expect(cue([user('u', 1), sub('s', 2, 'async_launched')])).toBe('thinking');
    expect(cue([user('u', 1), sub('s', 2, 'completed'), item('a', 3)])).toBe('working');
    // One still running earlier in the turn too (Codex runs tools side by side).
    expect(cue([user('u', 1), tool('b', 2, 'running'), item('a', 3)])).toBeNull();
    // Notices, hidden lines and unknown entries are skipped.
    expect(cue([user('u', 1), item('a', 2), item('n', 3, { kind: 'notice', notice: { text: 'x' } }), item('q', 4, { kind: 'unknown', hidden: true })])).toBe('working');
    expect(cue([user('u', 1), item('h', 2, { hidden: true })])).toBe('thinking');
  });

  it('the watermark: the previous turn’s text is not "Working…", nor its stale running tool a reason for silence', () => {
    const before = [user('u', 1), tool('b', 2, 'running'), item('a', 3)];
    expect(cue(before, 3)).toBe('thinking');
    expect(cue([...before, user('u2', 4)], 3)).toBe('thinking');
    expect(cue([...before, user('u2', 4), item('a2', 5)], 3)).toBe('working');
    // No watermark (sat down at a worker already at work): the last item as it is.
    expect(cue(before, null)).toBe('working');
    expect(cue([user('u', 1), tool('b', 2, 'running')], null)).toBeNull();
    expect(cue([tool('b', 1, 'running'), item('a', 2)], null)).toBe('working');
  });

  async function reading(h: ReturnType<typeof harness>, items: TranscriptItem[] = [item('a1', 1), item('a2', 2)]): Promise<FakeView> {
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', ack(items));
    await flush();
    h.tx.place({ left: 0, top: 0, width: 800, height: 500 });
    return h.views[0] as FakeView;
  }

  it('starts a turn when the worker starts working, follows its items, and goes with the status', async () => {
    const h = harness();
    const v = await reading(h);
    h.tx.activity('idle', 100);
    expect(h.tx.cueState).toBe('');
    h.tx.activity('working', 900);
    // The assistant text before is the last turn's: Thinking…, with the time since the status changed.
    expect(h.tx.cueState).toBe('thinking@900');
    expect(v.cues.at(-1)).toEqual({ kind: 'thinking', since: 900 });
    h.tx.push('a', [item('a3', 3)], []);
    expect(h.tx.cueState).toBe('working@900');
    h.tx.push('a', [item('t4', 4, { kind: 'tool', tool: { name: 'Bash', input_summary: '', status: 'running' } })], []);
    expect(h.tx.cueState).toBe('');
    h.tx.push('a', [], [item('t4', 4, { kind: 'tool', tool: { name: 'Bash', input_summary: '', status: 'ok' } })]);
    expect(h.tx.cueState).toBe('thinking@900');
    // Every frame calls it: the view hears only of changes.
    const n = v.cues.length;
    for (let i = 0; i < 10; i++) h.tx.activity('working', 900);
    expect(v.cues.length).toBe(n);
    // Blocked: the banner owns it; back to working is the same turn (the watermark stays).
    h.tx.activity('blocked', 1500);
    expect(v.cues.at(-1)).toBeNull();
    h.tx.activity('working', 1600);
    expect(h.tx.cueState).toBe('thinking@1600');
    h.tx.activity('done', 2000);
    expect(v.cues.at(-1)).toBeNull();
  });

  it('only while the conversation can be seen: not in terminal mode, off the view, or under a question card', async () => {
    const h = harness();
    const v = await reading(h);
    h.tx.activity('idle', 100);
    h.tx.activity('working', 900);
    expect(h.tx.cueState).toBe('thinking@900');
    h.tx.toggle();
    expect(h.tx.mode).toBe('terminal');
    expect(v.cues.at(-1)).toBeNull();
    h.tx.toggle();
    expect(h.tx.cueState).toBe('thinking@900');
    h.tx.place(null);
    expect(h.tx.cueState).toBe('');
    h.tx.place({ left: 0, top: 0, width: 800, height: 500 });
    expect(h.tx.cueState).toBe('thinking@900');
    h.tx.asked({ tool_use_id: 'toolu_q', since: 1, questions: [] } as unknown as Ask);
    expect(h.tx.cueState).toBe('');
    h.tx.asked(null);
    expect(h.tx.cueState).toBe('thinking@900');
  });

  it('sat down at a worker already working: no watermark, the last item as it is', async () => {
    const h = harness();
    await reading(h);
    h.tx.activity('working', 900);
    expect(h.tx.cueState).toBe('working@900');
  });
});

describe('pending prompts', () => {
  const user = (id: string, seq: number, text: string) => item(id, seq, { kind: 'user', parts: [{ text }] });
  const pending = (id: string, text: string, mark = 0, state: PendingPrompt['state'] = 'sent'): PendingPrompt => ({ id, text, state, late: false, mark, due: null });

  it('normalises like the CLIs write a prompt: trimmed, CRLF / CR as LF, image markers apart', () => {
    expect(promptKey('  fix it\r\nnow\r ')).toBe('fix it\nnow');
    expect(promptKey('see [Image #1: /tmp/a b.png] here')).toBe('see  here');
  });

  it('a user item after the mark takes the first prompt with its text; identical ones in order; refused ones never', () => {
    const ps = [pending('p1', 'go'), pending('p2', 'go'), pending('p3', 'other', 0, 'refused')];
    expect(reconcile(ps, [user('u', 1, ' go\n')]).map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(reconcile(ps, [user('u', 1, 'go'), user('v', 2, 'go')]).map((p) => p.id)).toEqual(['p3']);
    expect(reconcile(ps, [user('u', 1, 'other')])).toBe(ps);
    // An item from before the send is not it; neither is an assistant item.
    expect(reconcile([pending('p1', 'go', 5)], [user('u', 5, 'go'), item('go', 6)]).length).toBe(1);
    // Around an image marker the blanks may differ (the bridge splits the text there).
    const img = pending('p1', 'look\n[Image #1: /p/a.png]\n[Image #2: /p/b.png]\nat these');
    expect(reconcile([img], [item('u', 1, { kind: 'user', parts: [{ text: 'look\n' }, { text: '\nat these' }] })])).toEqual([]);
  });

  it('an item takes one prompt only, however often it comes again (an update, a resync)', () => {
    const ps = [pending('p1', 'go', 2, 'queued'), pending('p2', 'go', 2, 'queued')];
    const echo = user('u3', 3, 'go');
    const taken = new Set<string>();
    const once = reconcile(ps, [echo], taken);
    expect(once.map((p) => p.id)).toEqual(['p2']);
    expect(reconcile(once, [echo], taken)).toBe(once);
    // Given another id on the resync, it is still known by its place and text; a new item still takes p2.
    expect(reconcile(once, [{ ...echo, id: 'o:120' }], taken)).toBe(once);
    expect(reconcile(once, [echo, user('u4', 4, 'go')], taken)).toEqual([]);
  });

  it('one send: its item takes it, as before; the same words sent again wait for their own item', () => {
    const taken = new Set<string>();
    expect(reconcile([pending('p1', 'go', 2)], [user('u3', 3, 'go')], taken)).toEqual([]);
    const again = [pending('p2', 'go', 3)];
    expect(reconcile(again, [user('u3', 3, 'go')], taken)).toBe(again);
    expect(reconcile(again, [user('u3', 3, 'go'), user('u5', 5, 'go')], taken)).toEqual([]);
  });

  it('#138: a prompt the bridge rewrote matches its item by the text sent; either text takes it', () => {
    const ps = [{ ...pending('p1', 'use /grill on @a.go'), sent: 'use $grill on a.go' }];
    expect(reconcile(ps, [user('u', 1, 'use $grill on a.go')])).toEqual([]);
    // The typed text still matches (a Claude-like echo), and so do the blanks.
    expect(reconcile(ps, [user('u', 1, 'use /grill on @a.go')])).toEqual([]);
    expect(reconcile(ps, [user('u', 1, ' use  $grill on a.go\n')])).toEqual([]);
    expect(reconcile(ps, [user('u', 1, 'something else')])).toBe(ps);
    // Without `sent` (not rewritten) the translated text matches nothing: unchanged.
    const plain = [pending('p1', 'use /grill on @a.go')];
    expect(reconcile(plain, [user('u', 1, 'use $grill on a.go')])).toBe(plain);
  });

  async function reading(h: ReturnType<typeof harness>) {
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', ack([item('a1', 1), item('a2', 2)]));
    await flush();
    h.tx.place({ left: 0, top: 0, width: 800, height: 500 });
    const v = h.views[0] as FakeView;
    return { v, host: v.host };
  }
  const states = (h: ReturnType<typeof harness>) => h.tx.pending.map((p) => `${p.state}${p.late ? '+late' : ''}`);

  it('sent: a row at once, Sent on the ack, replaced (not doubled) by its user item; a second Enter meanwhile sends nothing', async () => {
    const h = harness();
    const { v, host } = await reading(h);
    h.tx.activity('idle', 100);
    const sent = host.onPromptSubmit('fix the test');
    // In the same frame: the view has the row, before any ack.
    expect(v.pending.at(-1)?.map((p) => [p.text, p.state])).toEqual([['fix the test', 'sending']]);
    await expect(host.onPromptSubmit('fix the test')).resolves.toBe(false);
    expect(h.sent.filter((c) => c.t === 'worker.prompt')).toHaveLength(1);
    h.sent[0]?.resolve({ ok: true, data: { queued: false, retried: false } });
    await expect(sent).resolves.toBe(true);
    expect(states(h)).toEqual(['sent']);
    // Its turn: the prompt it sent starts it.
    h.tx.activity('working', 900);
    expect(h.tx.cueState).toBe('thinking@900');
    h.tx.push('a', [user('u3', 3, 'fix the test')], []);
    expect(states(h)).toEqual([]);
    expect(v.pending.at(-1)).toEqual([]);
    expect(h.tx.itemCount).toBe(3);
  });

  it('#140: a prompt the bridge says shows only in the terminal (/usage) switches to the terminal, not remembered; its row goes', async () => {
    const h = harness();
    const { v, host } = await reading(h);
    h.tx.activity('idle', 100);
    const sent = host.onPromptSubmit('/usage');
    h.sent.find((c) => c.t === 'worker.prompt')?.resolve({ ok: true, data: { queued: false, retried: false, terminal: true } });
    await expect(sent).resolves.toBe(true);
    expect(h.tx.mode).toBe('terminal');
    expect(h.modes.at(-1)).toBe('terminal');
    // Its transcript will show nothing of it: no row waits for it.
    expect(states(h)).toEqual([]);
    expect(v.pending.at(-1)).toEqual([]);
    expect(h.status.at(-1)).toEqual(['ok', 'Sent to Ada: it shows in the terminal']);
    // Not where you left it: the next time you sit here it is the conversation again.
    expect(h.storage.getItem('h3d.seat.terminal')).toBeNull();
  });

  it('#140: any other prompt (/model opus, no `terminal` in the ack) stays in the conversation', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('/model opus');
    h.sent.find((c) => c.t === 'worker.prompt')?.resolve({ ok: true, data: { queued: false, retried: false } });
    await expect(sent).resolves.toBe(true);
    expect(h.tx.mode).toBe('transcript');
    expect(states(h)).toEqual(['sent']);
  });

  it('#140: a refused prompt never switches', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('/usage');
    h.sent.find((c) => c.t === 'worker.prompt')?.resolve({ ok: false, code: 'invalid_state', message: 'asleep' });
    await expect(sent).resolves.toBe(false);
    expect(h.tx.mode).toBe('transcript');
  });

  it('two identical sends, one shown before a resync: the resync keeps the other until its own item comes', async () => {
    const h = harness();
    const { v, host } = await reading(h);
    h.tx.activity('working', 900);
    for (const i of [0, 1]) {
      const sent = host.onPromptSubmit('go');
      h.sent[i]?.resolve({ ok: true, data: { queued: true, retried: false } });
      await sent;
    }
    expect(states(h)).toEqual(['queued', 'queued']);
    h.tx.push('a', [user('u3', 3, 'go')], []);
    expect(states(h)).toEqual(['queued']);
    // An update of that item, then the resync's whole timeline with it: the second one still waits.
    h.tx.push('a', [], [user('u3', 3, 'go')]);
    h.tx.reset('a', ack([item('a1', 1), item('a2', 2), user('u3', 3, 'go')]));
    expect(states(h)).toEqual(['queued']);
    expect(v.pending.at(-1)).toHaveLength(1);
    // Its own item in the next resync takes it.
    h.tx.reset('a', ack([item('a1', 1), item('a2', 2), user('u3', 3, 'go'), user('u4', 4, 'go')]));
    expect(states(h)).toEqual([]);
  });

  // #58: a new CLI session while seated (/new, /clear, a resume): the bridge closes the watch (`session_changed`) and
  // the re-watch acks the new transcript, its seqs counted from 1 again.
  const of = (session: string, items: TranscriptItem[], extra: Record<string, unknown> = {}) => watchAck({ harness: 'claude', session, cursor: 'c:1', items, ...extra });
  const send = async (h: ReturnType<typeof harness>, host: TranscriptRenderHost, text: string, queued = false) => {
    const sent = host.onPromptSubmit(text);
    h.sent.at(-1)?.resolve({ ok: true, data: { queued, retried: false } });
    await sent;
  };

  it('a new session: its echo at the place and with the words of one the old session had is its own', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('idle', 100);
    await send(h, host, 'go');
    h.tx.push('a', [user('old-uuid', 3, 'go')], []);
    expect(states(h)).toEqual([]);
    h.tx.reset('a', of('s2', [item('b1', 1), item('b2', 2)]));
    await send(h, host, 'go');
    expect(h.tx.pending.map((p) => p.mark)).toEqual([2]);
    h.tx.push('a', [user('new-uuid', 3, 'go')], []);
    expect(states(h)).toEqual([]);
  });

  it('a resync of the same session: an item still takes one prompt only, in the old session and in the new one', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('working', 900);
    await send(h, host, 'go', true);
    await send(h, host, 'go', true);
    h.tx.push('a', [user('u3', 3, 'go')], []);
    h.tx.reset('a', ack([item('a1', 1), item('a2', 2), user('u3', 3, 'go')]));
    expect(states(h)).toEqual(['queued']);
    h.tx.reset('a', of('s2', [item('b1', 1), item('b2', 2)]));
    await send(h, host, 'go', true);
    expect(states(h)).toEqual(['queued', 'queued']);
    h.tx.push('a', [user('n3', 3, 'go')], []);
    expect(states(h)).toEqual(['queued']);
    h.tx.push('a', [], [user('n3', 3, 'go')]);
    h.tx.reset('a', of('s2', [item('b1', 1), item('b2', 2), user('n3', 3, 'go')]));
    expect(states(h)).toEqual(['queued']);
    h.tx.reset('a', of('s2', [item('b1', 1), item('b2', 2), user('n3', 3, 'go'), user('n4', 4, 'go')]));
    expect(states(h)).toEqual([]);
  });

  it('a prompt still waiting when the session changes: its item may be anywhere in the new one', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('idle', 100);
    h.tx.push('a', [3, 4, 5, 6, 7, 8, 9].map((n) => item(`a${n}`, n)), []);
    // The send that starts the new session: its item is in the new session's first ack.
    await send(h, host, 'start over');
    expect(h.tx.pending.map((p) => p.mark)).toEqual([9]);
    h.tx.reset('a', of('s2', [user('n1', 1, 'start over'), item('n2', 2)]));
    expect(states(h)).toEqual([]);
    // One sent just before the switch, whose new transcript is not there yet: its item comes in the first push.
    await send(h, host, 'next');
    h.tx.reset('a', of('s3', [], { pending: true }));
    expect(states(h)).toEqual(['sent']);
    h.tx.push('a', [user('m1', 1, 'next')], [], { harness: 'claude', session: 's3' });
    expect(states(h)).toEqual([]);
    // A resync of the same session keeps the mark: an older item with those words is not the one.
    await send(h, host, 'next');
    h.tx.reset('a', of('s3', [user('m1', 1, 'next')]));
    expect(states(h)).toEqual(['sent']);
  });

  it("a pending watch's first push names its session: a resync of that session keeps what its items took", async () => {
    const h = harness();
    const wsent: Array<{ t: string; resolve: (r: CommandResult) => void }> = [];
    const tw = new TranscriptWatches({
      send: (t) => new Promise((resolve) => wsent.push({ t, resolve })),
      sink: { reset: (id, a) => h.tx.reset(id, a), push: (id, i, u, head) => h.tx.push(id, i, u, head), stop: () => {} },
      failed: () => {},
      closed: () => {},
      now: () => 0,
    });
    h.tx.sit('a', 'Ada');
    tw.sync(new Set(['a']));
    wsent[0]?.resolve({ ok: true, data: { harness: 'claude', session: '', cursor: 'c:1', pending: true, items: [] } });
    await flush();
    const host = (h.views[0] as FakeView).host;
    h.tx.activity('working', 900);
    await send(h, host, 'go', true);
    await send(h, host, 'go', true);
    tw.items({ t: 'transcript.items', id: 'a', items: [user('u1', 1, 'go')], updates: [], harness: 'claude', session: 's3', version: '', cursor: 'c:1', has_more: false, pending: false });
    expect(states(h)).toEqual(['queued']);
    tw.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    expect(wsent.at(-1)?.t).toBe('transcript.watch');
    wsent.at(-1)?.resolve({ ok: true, data: { harness: 'claude', session: 's3', cursor: 'c:1', items: [user('u1', 1, 'go')] } });
    await flush();
    expect(states(h)).toEqual(['queued']);
  });

  it("a pending watch's first push may be empty and still name its session: a resync of that session keeps what its items took", async () => {
    const h = harness();
    const wsent: Array<{ t: string; resolve: (r: CommandResult) => void }> = [];
    const tw = new TranscriptWatches({
      send: (t) => new Promise((resolve) => wsent.push({ t, resolve })),
      sink: { reset: (id, a) => h.tx.reset(id, a), push: (id, i, u, head) => h.tx.push(id, i, u, head), stop: () => {} },
      failed: () => {},
      closed: () => {},
      now: () => 0,
    });
    h.tx.sit('a', 'Ada');
    tw.sync(new Set(['a']));
    wsent[0]?.resolve({ ok: true, data: { harness: 'claude', session: '', cursor: 'c:1', pending: true, items: [] } });
    await flush();
    const host = (h.views[0] as FakeView).host;
    h.tx.activity('working', 900);
    await send(h, host, 'go', true);
    await send(h, host, 'go', true);
    // The transcript appeared with nothing in it yet: its head comes alone.
    tw.items({ t: 'transcript.items', id: 'a', items: [], updates: [], harness: 'claude', session: 's3', version: '', cursor: 'c:1', has_more: false, pending: false });
    expect(states(h)).toEqual(['queued', 'queued']);
    tw.items({ t: 'transcript.items', id: 'a', items: [user('u1', 1, 'go')], updates: [] });
    expect(states(h)).toEqual(['queued']);
    tw.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    expect(wsent.at(-1)?.t).toBe('transcript.watch');
    wsent.at(-1)?.resolve({ ok: true, data: { harness: 'claude', session: 's3', cursor: 'c:1', items: [user('u1', 1, 'go')] } });
    await flush();
    expect(states(h)).toEqual(['queued']);
  });

  it("the turn's mark is of the old session: after a switch the new session's items say what the turn does", async () => {
    const h = harness();
    await reading(h);
    h.tx.push('a', [3, 4, 5, 6].map((n) => item(`a${n}`, n)), []);
    h.tx.activity('idle', 100);
    h.tx.activity('working', 900);
    expect(h.tx.cueState).toBe('thinking@900');
    const running = item('t2', 2, { kind: 'tool', tool: { name: 'Bash', input_summary: '', status: 'running' } });
    h.tx.reset('a', of('s2', [user('n1', 1, 'x'), running]));
    // The running tool row speaks for itself.
    expect(h.tx.cueState).toBe('');
    h.tx.push('a', [], [{ ...running, tool: { name: 'Bash', input_summary: '', status: 'ok' } }]);
    expect(h.tx.cueState).toBe('thinking@900');
  });

  it('the item before the ack: the row goes, the ack does not bring it back', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('quick');
    h.tx.push('a', [user('u3', 3, 'quick')], []);
    expect(states(h)).toEqual([]);
    h.sent[0]?.resolve({ ok: true, data: { queued: false, retried: false } });
    await sent;
    expect(states(h)).toEqual([]);
  });

  it('#138: the ack says what the bridge sent: the item under that text takes the row', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('use /grill on @a.go');
    h.sent[0]?.resolve({ ok: true, data: { queued: false, retried: false, sent: 'use $grill on a.go' } });
    await sent;
    expect(states(h)).toEqual(['sent']);
    h.tx.push('a', [user('u3', 3, 'use $grill on a.go')], []);
    expect(states(h)).toEqual([]);
  });

  it('#138: the rewritten item before the ack: the ack takes the row', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('use /grill on @a.go');
    h.tx.push('a', [user('u3', 3, 'use $grill on a.go')], []);
    expect(states(h)).toEqual(['sending']);
    h.sent[0]?.resolve({ ok: true, data: { queued: false, retried: false, sent: 'use $grill on a.go' } });
    await sent;
    expect(states(h)).toEqual([]);
  });

  it('#138: a queued rewritten prompt is taken by its item under the text sent, before or after the ack', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('working', 900);
    const sent = host.onPromptSubmit('use /grill on @a.go');
    h.sent[0]?.resolve({ ok: true, data: { queued: true, retried: false, sent: 'use $grill on a.go' } });
    await sent;
    expect(states(h)).toEqual(['queued']);
    h.tx.push('a', [user('u3', 3, 'use $grill on a.go')], []);
    expect(states(h)).toEqual([]);
  });

  it('#138: an ack with no `sent` (not rewritten) is as before: the typed text only', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('use /grill on @a.go');
    h.sent[0]?.resolve({ ok: true, data: { queued: false, retried: false } });
    await sent;
    h.tx.push('a', [user('u3', 3, 'use $grill on a.go')], []);
    expect(states(h)).toEqual(['sent']);
    h.tx.push('a', [user('u4', 4, 'use /grill on @a.go')], []);
    expect(states(h)).toEqual([]);
  });

  it('queued: waits as long as the turn does, then gets the "not seen yet" hint; it is taken mid-turn too', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('working', 900);
    const cue = h.tx.cueState;
    const sent = host.onPromptSubmit('and then this');
    h.sent[0]?.resolve({ ok: true, data: { queued: true, retried: false } });
    await sent;
    expect(states(h)).toEqual(['queued']);
    // A queued prompt does not restart the turn or its time.
    expect(h.tx.cueState).toBe(cue);
    h.clock.t += 5 * 60_000;
    h.tx.activity('working', 900);
    expect(states(h)).toEqual(['queued']);
    h.tx.activity('done', 2000);
    h.clock.t += SENT_TIMEOUT_MS - 1;
    h.tx.activity('done', 2000);
    expect(states(h)).toEqual(['queued']);
    h.clock.t += 1;
    h.tx.activity('done', 2000);
    expect(states(h)).toEqual(['queued+late']);
    // Late is a hint: when it does come, it is replaced all the same.
    h.tx.push('a', [user('u3', 3, 'and then this')], []);
    expect(states(h)).toEqual([]);
  });

  it('sent but not seen within 15 s: the hint', async () => {
    const h = harness();
    const { host } = await reading(h);
    const sent = host.onPromptSubmit('hello');
    h.sent[0]?.resolve({ ok: true, data: {} });
    await sent;
    h.clock.t += SENT_TIMEOUT_MS;
    h.tx.activity('idle', 100);
    expect(states(h)).toEqual(['sent+late']);
  });

  it('send now: one Esc through worker.keys for a queued prompt, never two at once, and a failure says so', async () => {
    const h = harness();
    const { host } = await reading(h);
    h.tx.activity('working', 50);
    const sent = host.onPromptSubmit('hello');
    h.sent[0]?.resolve({ ok: true, data: { queued: true } });
    await sent;
    const id = h.tx.pending[0]?.id ?? '';
    host.onSendNow?.('nope');
    expect(h.sent).toHaveLength(1);
    host.onSendNow?.(id);
    host.onSendNow?.(id);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.t).toBe('worker.keys');
    expect(h.sent[1]?.args).toEqual({ id: 'a', input: [{ key: 'esc' }] });
    h.sent[1]?.resolve({ ok: false, code: 'input_failed', message: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    host.onSendNow?.(id);
    expect(h.sent).toHaveLength(3);
  });

  it('refused: an error row with the reason, the prompt kept (resolves false); the next send or Dismiss clears it', async () => {
    const h = harness();
    const { v, host } = await reading(h);
    const sent = host.onPromptSubmit('nope');
    h.sent[0]?.resolve({ ok: false, code: 'invalid_state', message: 'invalid state: Ada is blocked' });
    await expect(sent).resolves.toBe(false);
    expect(states(h)).toEqual(['refused']);
    expect(h.tx.pending[0]?.reason).toBeTruthy();
    expect(v.pending.at(-1)?.[0]?.state).toBe('refused');
    host.onDismissPending?.(h.tx.pending[0]?.id ?? '');
    expect(states(h)).toEqual([]);
    const again = host.onPromptSubmit('nope');
    h.sent[1]?.resolve({ ok: false, code: 'prompt_failed', message: 'x' });
    await again;
    void host.onPromptSubmit('yes');
    // The new send replaces the old error row.
    expect(states(h)).toEqual(['sending']);
    // Standing up forgets them.
    h.tx.stand();
    expect(h.tx.pending).toEqual([]);
  });
});

describe('#140: the prompt box’s commands', () => {
  const asks = (h: ReturnType<typeof harness>) => h.sent.filter((c) => c.t === 'worker.commands').map((c) => c.args.id);

  it('a Claude or Codex transcript asks for the worker’s commands as it opens and hands the list to the view', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    expect(asks(h)).toEqual(['a']);
    const c = h.views[0]?.host.commands;
    expect(c?.harness).toBe('claude');
    expect(c?.list.state.loading).toBe(true);
    h.sent.find((x) => x.t === 'worker.commands')?.resolve({ ok: true, data: { commands: [{ name: 'compact', description: '', argument_hint: '', kind: 'command' }], partial: false } });
    await flush();
    expect(c?.list.state.commands?.map((x) => x.name)).toEqual(['compact']);
    // Sitting down again: the same list (shown at once), asked again as the view opens.
    h.tx.stand();
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    expect(h.views[1]?.host.commands?.list).toBe(c?.list);
    expect(asks(h)).toEqual(['a', 'a']);
    h.tx.stand();
    h.tx.sit('b', 'Bo', true, 'codex');
    await flush();
    expect(h.views[2]?.host.commands?.harness).toBe('codex');
    expect(asks(h)).toEqual(['a', 'a', 'b']);
  });

  it('a seat opened in the terminal asks nothing until the transcript opens', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada', false, 'claude');
    await flush();
    expect(asks(h)).toEqual([]);
  });

  it('another harness (or none known): no commands, nothing asked', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    await flush();
    expect(h.views[0]?.host.commands).toBeNull();
    h.tx.stand();
    h.tx.sit('b', 'Bo', true, 'other');
    await flush();
    expect(h.views[1]?.host.commands).toBeNull();
    expect(asks(h)).toEqual([]);
  });
});

describe('#141: the prompt box’s draft and file search', () => {
  const file = (path: string, dir = false) => ({ kind: 'file' as const, path, dir });

  it('each worker keeps its own draft across seats: the next view of it shows the same draft object', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    const d = h.views[0]?.host.draft;
    d?.insertParts(0, 0, ['see ', file('src/a.ts')]);
    h.tx.stand();
    h.tx.sit('b', 'Bo', true, 'claude');
    await flush();
    expect(h.views[1]?.host.draft).not.toBe(d);
    expect(h.views[1]?.host.draft?.doc.text).toBe('');
    h.tx.stand();
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    expect(h.views[2]?.host.draft).toBe(d);
    expect(d?.disposed).toBe(false);
    expect(d?.snapshot().files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('a reload brings back the text and the file chips (images do not survive it)', async () => {
    const storage = new MemStorage();
    const h = harness({ storage });
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    h.views[0]?.host.draft?.insertParts(0, 0, ['see ', file('my d/a b.ts'), ' and ', file('src', true)]);
    expect(JSON.parse(storage.getItem('h3d.draft.transcript.a') ?? 'null')).toMatchObject({ v: 1, text: 'see  and ' });
    const again = harness({ storage });
    again.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    const d = again.views[0]?.host.draft;
    expect(d?.snapshot().segments.map((g) => (g.kind === 'file' ? `{${g.path}${g.dir ? '/' : ''}}` : g.kind === 'text' ? g.text : '<img>'))).toEqual(['see ', '{my d/a b.ts}', ' and ', '{src/}']);
    expect(d?.canUndo).toBe(false);
  });

  it('a sent prompt clears the draft, and what storage kept; an edit made after the send survives it', async () => {
    const storage = new MemStorage();
    const h = harness({ storage });
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    const d = h.views[0]!.host.draft!;
    d.insertParts(0, 0, [file('a.ts')]);
    const rev = d.revision;
    expect(d.clearIf(rev)).toBe(true);
    expect(storage.getItem('h3d.draft.transcript.a')).toBeNull();
    d.insertParts(0, 0, ['new']);
    expect(d.clearIf(rev)).toBe(false);
    expect(storage.getItem('h3d.draft.transcript.a')).not.toBeNull();
  });

  it('blocked storage leaves the drafts in memory', async () => {
    const h = harness({ storage: throwing });
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    h.views[0]?.host.draft?.replace(0, 0, 'still here');
    h.tx.stand();
    h.tx.sit('a', 'Ada', true, 'claude');
    await flush();
    expect(h.views[1]?.host.draft?.doc.text).toBe('still here');
  });

  it('hands the view a file search over the worker’s checkout, which asks the bridge for it', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada', true, 'codex');
    await flush();
    const f = h.views[0]?.host.files;
    expect(f?.id).toBe('a');
    void f?.search.send('worker.files', { id: 'a', query: 'comp', limit: 30 });
    expect(h.sent.at(-1)).toMatchObject({ t: 'worker.files', args: { id: 'a', query: 'comp', limit: 30 } });
  });
});

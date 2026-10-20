// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptDiff, TranscriptItem } from '../net/protocol';
import { ViewPrefs } from '../ui/themePrefs';

// #126: what the merging of image runs is asked to look at, per call (a backfill slice must not look at everything).
const runs = vi.hoisted(() => ({ sizes: [] as number[] }));
vi.mock('./transcriptImages', async (actual) => {
  const m = await actual<typeof import('./transcriptImages')>();
  return {
    ...m,
    imageRuns: (items: readonly TranscriptItem[], showSystem: boolean) => {
      runs.sizes.push(items.length);
      return m.imageRuns(items, showSystem);
    },
  };
});

const { backfill, mountTranscript } = await import('./transcriptRender');
type View = ReturnType<typeof mountTranscript>;
type Host = Parameters<typeof mountTranscript>[1];

// #126: opening a transcript: "opening" until the watch answers (never "No conversation yet." before), the newest rows
// first and the older ones built above them in the background, a slice at a time (the timers here), what comes live
// meanwhile, a start over or the view going away during it; system rows built only once they show, changed files' lines
// only once they come near the view.

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const say = (n: number, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id: `a${n}`, seq: n, ts: T0 + n * 1000, kind: 'assistant', parts: [{ text: `step ${n}` }], ...extra });
const notice = (n: number): TranscriptItem => ({ id: `n${n}`, seq: n, ts: T0 + n * 1000, kind: 'notice', hidden: true, notice: { text: `system ${n}` } });
const shot = (n: number): TranscriptItem => ({
  id: `s${n}`,
  seq: n,
  ts: T0 + n * 1000,
  kind: 'user',
  parts: [{ image: { hash: String(n).padStart(64, '0'), mime: 'image/png', bytes: 10, width: 40, height: 30, source: 'path', origin: 'input', path: `/tmp/${n}.png` } }],
});
const many = (from: number, to: number, f: (n: number) => TranscriptItem = say) => Array.from({ length: to - from + 1 }, (_, i) => f(from + i));

function host(extra: Partial<Host> = {}): Host {
  return {
    images: null,
    prefs: new ViewPrefs(null),
    onPromptSubmit: async () => true,
    onAnswer: () => {},
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => {},
    loadSubagent: async () => [],
    ...extra,
  };
}

let container: HTMLDivElement;
let view: View;
const saved = { ...backfill };
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const ids = () => [...container.querySelectorAll<HTMLElement>('.tx-list:not(.tx-nested) > .tx-item')].map((r) => r.dataset.id);
const building = () => !!$('.tx[data-building]');
/** One backfill slice: its yield (a frame, then a timeout) resolves and the slice runs. */
const slice = () => vi.advanceTimersByTimeAsync(20);
async function built(): Promise<number> {
  let n = 0;
  while (building() && n < 500) {
    await slice();
    n++;
  }
  return n;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  runs.sizes = [];
});
afterEach(() => {
  view?.destroy();
  container.remove();
  Object.assign(backfill, saved);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('#126: opening, not empty', () => {
  it('says the conversation is opening until the watch answers; empty only after an ack with nothing', () => {
    view = mountTranscript(container, host({ loading: true, label: 'Tofu' }));
    const empty = $('.tx-empty') as HTMLElement;
    const loader = $('.txl') as HTMLElement;
    expect(empty.hidden).toBe(true);
    expect(loader.hidden).toBe(false);
    expect(loader.getAttribute('role')).toBe('status');
    expect(loader.textContent).toBe('Opening Tofu’s conversation…');
    // The view mounts with the items it has (none before the ack): still opening.
    view.setItems([]);
    expect(empty.hidden).toBe(true);
    expect(loader.hidden).toBe(false);
    view.setLoading?.(false);
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe('No conversation yet.');
    expect(loader.hidden).toBe(true);
  });

  it('an ack with items goes straight from opening to the rows, and a resync never shows the empty state', () => {
    view = mountTranscript(container, host({ loading: true }));
    const empty = $('.tx-empty') as HTMLElement;
    const loader = $('.txl') as HTMLElement;
    const items = many(1, 5);
    view.setItems(items);
    expect(loader.hidden).toBe(true);
    expect(empty.hidden).toBe(true);
    view.setLoading?.(false);
    const first = $('[data-id="a3"]');
    // A re-watch's ack: the same items, sent anew. The rows stay (the same elements), nothing flashes.
    view.setItems(items.map((it) => structuredClone(it)));
    expect(empty.hidden).toBe(true);
    expect(loader.hidden).toBe(true);
    expect($('[data-id="a3"]')).toBe(first);
    expect(ids()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    // A changed item is drawn anew; the others stay.
    view.setItems([...items.slice(0, 2).map((it) => structuredClone(it)), say(3, { parts: [{ text: 'changed' }] }), ...items.slice(3)]);
    expect($('[data-id="a3"]')).not.toBe(first);
    expect($('[data-id="a3"]')?.textContent).toContain('changed');
  });

  it('a host that says nothing is answered (no outline)', () => {
    view = mountTranscript(container, host());
    expect(($('.txl') as HTMLElement).hidden).toBe(true);
    expect(($('.tx-empty') as HTMLElement).hidden).toBe(false);
  });
});

describe('#126: the newest rows first, the older ones in the background', () => {
  it('builds the newest rows at once and the older ones above them a slice at a time, in order', async () => {
    view = mountTranscript(container, host());
    view.setItems(many(1, 300));
    // A view with no layout (here) builds its first screenful by count.
    expect(ids()).toEqual(many(271, 300).map((it) => it.id));
    expect(building()).toBe(true);
    // Every item is known at once: the count is the timeline's, not the rows'.
    expect($('.tx-count')?.textContent).toBe('300 entries');
    await slice();
    const after = ids();
    expect(after.length).toBeGreaterThan(30);
    expect(after.length).toBeLessThanOrEqual(30 + 60);
    expect(after.at(-1)).toBe('a300');
    const slices = await built();
    expect(slices).toBeGreaterThan(2);
    expect(ids()).toEqual(many(1, 300).map((it) => it.id));
    expect(building()).toBe(false);
  });

  it('a slice stops when its budget is spent', async () => {
    let t = 0;
    backfill.now = () => (t += 3); // every row takes 3 ms
    backfill.budgetMs = 8;
    view = mountTranscript(container, host());
    view.setItems(many(1, 100));
    const first = ids().length;
    await slice();
    // The rows built while 8 ms had not gone by (a clock read per row): a few, not the slice's most.
    expect(ids().length - first).toBeGreaterThan(0);
    expect(ids().length - first).toBeLessThanOrEqual(3);
  });

  it('keeps what you read where it is while rows go in above it, and the bottom when you follow it', async () => {
    view = mountTranscript(container, host());
    const scroller = $('.tx-scroll') as HTMLElement;
    // jsdom lays nothing out: 20 px a row, a 200 px view.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scroller.querySelectorAll('.tx-list > .tx-item').length * 20 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 });
    view.setItems(many(1, 200));
    expect(scroller.scrollTop).toBe(scroller.scrollHeight); // stuck to the bottom
    await slice();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight); // following: still the bottom
    // Scrolled up to read: 300 px from the bottom.
    scroller.scrollTop = scroller.scrollHeight - 300;
    scroller.dispatchEvent(new Event('scroll'));
    const before = scroller.scrollHeight - scroller.scrollTop;
    const rows = ids().length;
    await slice();
    expect(ids().length).toBeGreaterThan(rows);
    expect(scroller.scrollHeight - scroller.scrollTop).toBe(before);
    await built();
    expect(scroller.scrollHeight - scroller.scrollTop).toBe(before);
  });

  it('merges an image run across a slice boundary, looking only at the slice and the run it joins', async () => {
    view = mountTranscript(container, host());
    // 26 screenshots in a row, the newest 30 rows built first: the run starts among the older ones.
    view.setItems([...many(1, 50), ...many(51, 76, shot), ...many(77, 80)]);
    const total = 80;
    runs.sizes = [];
    await built();
    // No slice merged the whole timeline again.
    expect(runs.sizes.length).toBeGreaterThan(0);
    expect(Math.max(...runs.sizes)).toBeLessThan(total);
    const lead = $('[data-id="s51"]') as HTMLElement;
    expect(lead.hidden).toBe(false);
    expect(lead.querySelectorAll('.tx-strip > *').length).toBe(26);
    for (let n = 52; n <= 76; n++) expect(($(`[data-id="s${n}"]`) as HTMLElement).classList.contains('tx-merged')).toBe(true);
  });

  it('a start over (resync, session_changed) ends the backfill it replaces; going away ends it too', async () => {
    view = mountTranscript(container, host());
    view.setItems(many(1, 300));
    await slice();
    view.setItems(many(1001, 1100));
    await built();
    expect(ids()).toEqual(many(1001, 1100).map((it) => it.id));
    view.setItems(many(1, 300));
    const list = $('.tx-list') as HTMLElement;
    const rows = list.childElementCount;
    view.destroy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(list.childElementCount).toBe(rows);
    expect(list.isConnected).toBe(false);
  });

  it('takes live updates meanwhile: new rows at the bottom, rows not built yet as they are when built, older ones in order', async () => {
    view = mountTranscript(container, host());
    view.setItems(many(1, 200, (n) => say(n * 2)));
    await slice();
    // a2 (seq 2) is still to build; a400 (seq 400) has its row.
    expect($('[data-id="a2"]')).toBeNull();
    const top = $('[data-id="a400"]');
    view.applyUpdates([say(1, { id: 'a2', seq: 2, parts: [{ text: 'rewritten while waiting' }] }), say(401, { id: 'live' }), say(3, { id: 'late' }), say(400, { parts: [{ text: 'now done' }] })]);
    expect(ids().at(-1)).toBe('live');
    expect($('[data-id="a400"]')).not.toBe(top);
    expect($('[data-id="a400"]')?.textContent).toContain('now done');
    expect($('[data-id="late"]')).toBeNull(); // older than every row built: it waits with them
    await built();
    expect($('[data-id="a2"]')?.textContent).toContain('rewritten while waiting');
    const seqOf = (id: string) => (id === 'live' ? 401 : id === 'late' ? 3 : Number(id.slice(1)));
    const order = ids() as string[];
    expect(order).toHaveLength(202);
    expect([...order].sort((a, b) => seqOf(a) - seqOf(b))).toEqual(order);
    expect(order.indexOf('late')).toBe(1);
  });

  it('a jump to an item not built yet builds down to it', () => {
    view = mountTranscript(container, host());
    Element.prototype.scrollIntoView ??= () => {};
    view.setItems(many(1, 300));
    expect($('[data-id="a10"]')).toBeNull();
    expect(view.hasItem('a10')).toBe(true);
    expect(view.scrollToItem('a10')).toBe(true);
    expect($('[data-id="a10"]')).not.toBeNull();
    expect(ids().indexOf('a10')).toBe(9);
  });
});

describe('#126: built when they show', () => {
  it('builds no hidden system row until "Show system", counting them all along; the backfill builds them once shown', async () => {
    view = mountTranscript(container, host());
    const items = many(1, 200, (n) => (n % 2 ? notice(n) : say(n)));
    view.setItems(items);
    const btn = $('.tx-sys-toggle') as HTMLButtonElement;
    expect(btn.textContent).toBe('Show system (100)');
    expect(container.querySelectorAll('.tx-sys').length).toBe(0);
    expect($('.tx-count')?.textContent).toBe('100 entries');
    await slice();
    btn.click();
    expect(btn.textContent).toBe('Hide system (100)');
    const shown = container.querySelectorAll('.tx-sys').length;
    expect(shown).toBeGreaterThan(0);
    await built();
    expect(container.querySelectorAll('.tx-sys').length).toBe(100);
    expect(ids()).toEqual(items.map((it) => it.id));
  });

  it('counts tool calls from the timeline, not from the rows built so far', () => {
    view = mountTranscript(container, host());
    view.setItems(many(1, 120, (n) => ({ id: `t${n}`, seq: n, ts: T0 + n, kind: 'tool', tool: { name: 'Bash', input_summary: `ls ${n}`, status: 'ok', output_text: '' } })));
    expect(ids().length).toBeLessThan(120);
    expect($('.tx-check-n')?.textContent).toBe('120');
  });

  it('draws a changed file’s lines once it comes near the view, keeping #21’s default and its counts', async () => {
    let seen: IntersectionObserverCallback | null = null;
    const observed: Element[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          seen = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const lines = Array.from({ length: 120 }, (_, i) => `+line ${i + 1}`);
    const diff: TranscriptDiff = { path: 'src/a.ts', hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: 120, lines }] };
    view = mountTranscript(container, host());
    view.setItems([{ id: 'e1', seq: 1, ts: T0, kind: 'tool', tool: { name: 'Edit', input_summary: 'src/a.ts', status: 'ok', diff } }]);
    expect($('.tx')?.getAttribute('data-changes')).toBe('shown');
    expect($('.tx-chg-head')?.getAttribute('aria-expanded')).toBe('true');
    expect($('.tx-chg-head .tx-add-n')?.textContent).toBe('+120');
    expect($('.tx-tool-row .tx-add-n')?.textContent).toBe('+120');
    const body = $('.tx-diff-body') as HTMLElement;
    // Not drawn yet: its room kept (a line of its font each).
    expect(body.querySelectorAll('.tx-dl').length).toBe(0);
    expect(body.style.height).toBe('181.5em'); // the hunk's header and its 120 lines
    expect(observed).toContain(body);
    (seen as unknown as IntersectionObserverCallback)([{ target: body, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    // Its first lines at once, the rest the frames after.
    expect(body.querySelectorAll('.tx-dl:not(.tx-dh)').length).toBe(50);
    expect(body.style.height).toBe('181.5em');
    await vi.advanceTimersByTimeAsync(200);
    expect(body.querySelectorAll('.tx-dl:not(.tx-dh)').length).toBe(120);
    expect(body.style.height).toBe('');
    // Closed and opened by hand, as before (#171).
    ($('.tx-chg-head') as HTMLButtonElement).click();
    expect(($('.tx-chg-body') as HTMLElement).hidden).toBe(true);
    ($('.tx-chg-head') as HTMLButtonElement).click();
    expect(($('.tx-chg-body') as HTMLElement).hidden).toBe(false);
    expect(body.querySelectorAll('.tx-dl:not(.tx-dh)').length).toBe(120);
  });

  it('a long diff not drawn yet already says what "Show next" adds', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const lines = Array.from({ length: 2500 }, (_, i) => `+line ${i + 1}`);
    view = mountTranscript(container, host());
    view.setItems([{ id: 'e1', seq: 1, ts: T0, kind: 'tool', tool: { name: 'Write', input_summary: 'big.ts', status: 'ok', diff: { path: 'big.ts', hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 2500, lines }] } } }]);
    expect($('.tx-diff-more .tx-link')?.textContent).toBe('Show next 500 lines (500 left)');
    // A click draws what was put off, then the next lines.
    ($('.tx-diff-more .tx-link') as HTMLButtonElement).click();
    expect(container.querySelectorAll('.tx-dl:not(.tx-dh)').length).toBe(2500);
    expect($('.tx-diff-more')).toBeNull();
  });
});

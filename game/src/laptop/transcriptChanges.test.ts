// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptDiff, TranscriptItem } from '../net/protocol';
import { ViewPrefs } from '../ui/themePrefs';
import { diffColoursBusy, MAIN_BUDGET } from './diffHighlight';
import { mountTranscript, toolHasChanges, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

/**
 * #171: code changes show by default, outside the tool row's raw input and output: Claude's Edit and Write diffs and what
 * Bash calls changed (bashEditDiff), each file with what happened to it, and what the record says beyond its diffs. Fed
 * what the bridge sends for its own fixtures (fixtures/transcript/claude-changes.json, kept in step with
 * internal/transcript by its TestGameFixtures): a restored history.
 */

const CHANGES = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/transcript/claude-changes.json'), 'utf8')) as TranscriptItem[];
const CODEX = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/transcript/codex.json'), 'utf8')) as TranscriptItem[];

interface Host extends TranscriptRenderHost {
  itemLoads: Array<[string, string | undefined]>;
}

let container: HTMLDivElement;
let view: TranscriptView;
let host: Host;
let prefs: ViewPrefs;

function mount(loadItem?: (id: string, agent?: string) => Promise<TranscriptItem | null>, subagent: TranscriptItem[] = []): TranscriptView {
  const loads: Array<[string, string | undefined]> = [];
  host = {
    images: null,
    itemLoads: loads,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => {},
    onAnswerAsk: async () => ({ ok: true, resolved: true }),
    onSwitchToTerminal: () => {},
    loadSubagent: async () => subagent,
    prefs,
    ...(loadItem
      ? {
          loadItem: (id: string, agent?: string) => {
            loads.push([id, agent]);
            return loadItem(id, agent);
          },
        }
      : {}),
  };
  view = mountTranscript(container, host);
  return view;
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = container) => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = container) => [...root.querySelectorAll<E>(sel)];
const row = (id: string) => $(`[data-id="${id}"]`) as HTMLElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
/** A row's changed files: header text and whether its diff is open. */
const files = (id: string) =>
  $$('.tx-chg-file', row(id)).map((f) => ({
    path: $('.tx-diff-path', f)?.textContent,
    op: $$('.tx-chg-op', f).map((e) => e.textContent),
    stat: $('.tx-diff-stat', f)?.textContent ?? null,
    open: $('.tx-chg-head', f)?.getAttribute('aria-expanded') === 'true' && !($('.tx-chg-body', f) as HTMLElement).hidden,
  }));
const notes = (id: string) => $$('.tx-chg-note, .tx-chg-more > summary, .tx-chg-state', row(id)).map((e) => e.textContent);
/** A row shows while tool calls are hidden (the CSS rule's terms: what it keeps then). */
const keptWhenHidden = (id: string) => {
  const r = row(id);
  return !r.classList.contains('tx-toolrow') || r.classList.contains('tx-toolimg') || r.classList.contains('tx-toolchg');
};
const P = '/home/dev/project/';

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  prefs = new ViewPrefs(null);
});
afterEach(() => {
  view?.destroy();
  container.remove();
});

describe('code changes (#171)', () => {
  it('show by default, under the tool header, with the raw input and output still closed', () => {
    mount();
    view.setItems(CHANGES);
    expect(container.querySelector('.tx')?.getAttribute('data-changes')).toBe('shown');
    expect(($('.tx-check-changes input') as HTMLInputElement).checked).toBe(true);
    const edit = row('toolu_018mQCao59VwQiRK6L6zHu5h');
    expect(edit.querySelector('.tx-tool-body')?.hasAttribute('hidden')).toBe(true);
    expect($$(':scope > *', edit).map((e) => e.className)).toEqual(['tx-tool-row', 'tx-changes', 'tx-tool-body']);
    expect(files('toolu_018mQCao59VwQiRK6L6zHu5h')).toEqual([{ path: '/home/dev/.herdr/worktrees/herdr-3d/feat-33-transcript-shell/game/src/net/protocol.ts', op: [], stat: '+5 −0', open: true }]);
    // Line numbers from the source: the hunk starts at 369 on both sides.
    expect($('.tx-dh', edit)?.textContent).toBe('@@ -369,6 +369,11 @@');
    expect($$('.tx-dl:not(.tx-dh) .tx-dn', edit).slice(0, 2).map((n) => n.textContent)).toEqual(['369', '369']);
    expect($('.tx-chg-state', edit)).toBeNull(); // applied: nothing to say
  });

  it('say what happened to each file: new, overwritten (with or without hunks), deleted; never a new file for an overwrite', () => {
    mount();
    view.setItems(CHANGES);
    expect(files('toolu_01R9TX6cEVUznrPKxDcBh5bN')[0]?.op).toEqual(['new']);
    expect(files('toolu_c171_wr_upd1')).toEqual([{ path: `${P}docs/notes.md`, op: ['overwritten'], stat: '+1 −1', open: true }]);
    expect(files('toolu_c171_wr_upd2')).toEqual([{ path: `${P}config/app.toml`, op: ['overwritten'], stat: '+2 −3', open: true }]);
    // No hunks: overwritten, no counts made up, and why there is no diff.
    const nodiff = 'toolu_c171_wr_nodiff';
    expect(files(nodiff)).toEqual([{ path: `${P}assets/map.json`, op: ['overwritten', 'no diff'], stat: null, open: true }]);
    expect(row(nodiff).querySelector('.tx-tool-row .tx-diff-stat')).toBeNull();
    expect($$('.tx-dl', row(nodiff))).toEqual([]);
    expect(notes(nodiff)).toEqual(['No diff recorded: Claude Code keeps none when nothing changed, the old file was too large, or the diff timed out.']);
  });

  it('Bash: one file, several (created, deleted, an empty new one), counts summed on the header', () => {
    mount();
    view.setItems(CHANGES);
    expect(files('toolu_c171_bash_one')).toEqual([{ path: `${P}src/fetch.py`, op: [], stat: '+1 −1', open: true }]);
    expect($('.tx-dh', row('toolu_c171_bash_one'))?.textContent).toBe('@@ -12,5 +12,5 @@');
    const multi = 'toolu_c171_bash_multi';
    expect(files(multi).map((f) => [f.path?.slice(P.length), f.op, f.stat])).toEqual([
      ['src/helpers.py', [], '+1 −5'],
      ['src/text.py', ['new'], '+2 −0'],
      ['src/legacy_math.py', ['deleted'], '+0 −2'],
      ['src/__init__.py', ['new'], '+0 −0'],
    ]);
    expect(row(multi).querySelector('.tx-tool-row .tx-diff-stat')?.textContent).toBe('+3 −7');
    expect($$('.tx-chg-file', row(multi))[3]?.textContent).toContain('Empty file.');
    // Nothing more to say: every changed file has its diff.
    expect(notes(multi)).toEqual(['Empty file.']);
  });

  it('Bash: files changed without a diff, incomplete, not taken, shared: said plainly, never as complete', () => {
    mount();
    view.setItems(CHANGES);
    expect(notes('toolu_c171_bash_more')).toEqual(['3 more files changed, no diff recorded']);
    expect($$('.tx-chg-paths li', row('toolu_c171_bash_more')).map((e) => e.textContent)).toEqual([`${P}src/c.ts`, `${P}src/d.ts`, `${P}src/e.ts`]);
    expect(notes('toolu_c171_bash_paths')).toEqual(['2 files changed, no diff recorded']);
    expect(files('toolu_c171_bash_paths')).toEqual([]);
    expect(notes('toolu_c171_bash_unavail')).toEqual(['1 more file changed, no diff recorded', 'Incomplete: Claude Code could not record all of this command’s changes.']);
    expect(files('toolu_c171_bash_unavail').map((f) => f.path)).toEqual([`${P}VERSION`]); // its diff is still real
    // Nothing listed and shared: only that nothing could be recorded (shared says nothing of changes it does not list).
    expect(notes('toolu_c171_bash_unavail0')).toEqual(['Not recorded: Claude Code could not take this command’s changes.']);
    expect(notes('toolu_c171_bash_shared')).toEqual(['Another command ran in this repository at the same time: some of these changes may be its.']);
    expect(notes('toolu_c171_bash_skipped')).toEqual(['No diff taken: this command moves the working tree (like git checkout or git stash).']);
  });

  it('show nothing extra where the source said nothing (unknown, not "no changes"), nor for a failed, denied or stopped edit', () => {
    mount();
    view.setItems(CHANGES);
    for (const id of ['toolu_018Aah2uHCqF4KbGuUkTSEYa', 'toolu_c171_bash_sharedonly', 'toolu_c171_edit_fail', 'toolu_c171_bash_fail', 'toolu_c171_write_denied', 'toolu_c171_edit_waiting']) {
      expect(row(id).querySelector('.tx-changes'), id).toBeNull();
      expect(row(id).classList.contains('tx-toolchg'), id).toBe(false);
    }
    expect(row('toolu_c171_write_denied').dataset.status).toBe('denied');
    expect(row('toolu_c171_write_denied').querySelector('.tx-tool-status')?.textContent).toBe('denied');
    expect(row('toolu_c171_edit_waiting').querySelector('.tx-tool-status')?.textContent).toBe('interrupted');
  });

  it('distinguish proposed, failed, denied and interrupted diffs from applied ones', () => {
    mount();
    const diff: TranscriptDiff = { path: 'a.go', hunks: [{ old_start: 0, old_lines: 1, new_start: 0, new_lines: 1, lines: ['-x', '+y'] }] };
    const tool = (id: string, status: 'running' | 'ok' | 'error' | 'denied' | 'interrupted'): TranscriptItem => ({ id, seq: id.length, ts: 0, kind: 'tool', tool: { name: 'apply_patch', input_summary: 'a.go', status, diff } });
    view.setItems([tool('p', 'running'), tool('ok', 'ok'), tool('err', 'error'), tool('deny', 'denied'), tool('stop', 'interrupted')]);
    const state = (id: string) => [$('.tx-changes', row(id))?.getAttribute('data-state'), $('.tx-chg-state', row(id))?.textContent ?? null];
    expect(state('p')).toEqual(['proposed', 'Proposed: not applied yet.']);
    expect(state('ok')).toEqual(['applied', null]);
    expect(state('err')).toEqual(['failed', 'The call failed: these changes may not have been applied, or only in part.']);
    expect(state('deny')).toEqual(['denied', 'Denied: not applied.']);
    expect(state('stop')).toEqual(['partial', 'Interrupted: these changes may be only partly applied.']);
    // The result arrives: the same row, applied.
    view.applyUpdates([tool('p', 'ok')]);
    expect(state('p')).toEqual(['applied', null]);
  });

  it('keep existing Codex diffs: no line numbers made up, no file fate made up, shown without opening the row', () => {
    mount();
    view.setItems(CODEX);
    const patch = CODEX.find((it) => it.tool?.name === 'apply_patch') as TranscriptItem;
    const r = row(patch.id);
    expect(files(patch.id).map((f) => [f.path, f.op, f.open])).toEqual([
      ['package.json', [], true],
      ['tsconfig.json', [], true],
    ]);
    expect($('.tx-dh', r)).toBeNull();
    expect($$('.tx-dl .tx-dn', r).every((n) => n.textContent === '')).toBe(true);
    expect(r.querySelector('.tx-tool-body')?.hasAttribute('hidden')).toBe(true);
  });

  it('"Show code changes" off: one line per file (path, fate, counts), each still opens; on again: the same history, open', () => {
    mount();
    view.setItems(CHANGES);
    const all = () => $$('.tx-chg-file').map((f) => $('.tx-chg-head', f)?.getAttribute('aria-expanded'));
    expect(all().every((o) => o === 'true')).toBe(true);
    const before = $$('.tx-chg-head').map((e) => e.textContent);
    ($('.tx-check-changes input') as HTMLInputElement).click();
    expect(prefs.showChanges).toBe(false);
    expect(container.querySelector('.tx')?.getAttribute('data-changes')).toBe('hidden');
    expect(all().every((o) => o === 'false')).toBe(true);
    expect($$('.tx-chg-body').every((b) => (b as HTMLElement).hidden)).toBe(true);
    expect($$('.tx-chg-head').map((e) => e.textContent)).toEqual(before); // the summary stays
    expect(notes('toolu_c171_bash_more')).toEqual(['3 more files changed, no diff recorded']); // so does what has no diff
    // One opens by itself, and stays open across a re-render (a live update of its row).
    ($('.tx-chg-head', row('toolu_c171_bash_one')) as HTMLButtonElement).click();
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(true);
    view.applyUpdates([CHANGES.find((it) => it.id === 'toolu_c171_bash_one') as TranscriptItem]);
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(true);
    expect(files('toolu_c171_bash_multi').every((f) => !f.open)).toBe(true);
    // On again: every change open, the same rows.
    prefs.showChanges = true;
    expect(all().every((o) => o === 'true')).toBe(true);
    expect($$('.tx-chg-head').map((e) => e.textContent)).toEqual(before);
    // Each one closes by itself while the switch is on.
    ($('.tx-chg-head', row('toolu_c171_bash_one')) as HTMLButtonElement).click();
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(false);
    expect(files('toolu_c171_bash_multi').every((f) => f.open)).toBe(true);
  });

  it('a new view starts with the stored choice', () => {
    prefs.showChanges = false;
    mount();
    view.setItems(CHANGES);
    expect(($('.tx-check-changes input') as HTMLInputElement).checked).toBe(false);
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(false);
    expect($$('.tx-dl', row('toolu_c171_bash_one'))).toEqual([]); // not drawn until opened
  });

  it('"Hide tools" hides generic tool rows but keeps code changes; the two switches are independent', () => {
    mount();
    view.setItems(CHANGES);
    prefs.hideTools = true;
    expect(container.querySelector('.tx')?.getAttribute('data-tools')).toBe('hidden');
    expect(keptWhenHidden('toolu_c171_bash_one')).toBe(true);
    expect(keptWhenHidden('toolu_c171_wr_nodiff')).toBe(true);
    expect(keptWhenHidden('toolu_c171_bash_paths')).toBe(true);
    expect(keptWhenHidden('toolu_018Aah2uHCqF4KbGuUkTSEYa')).toBe(false); // a plain Bash
    expect(keptWhenHidden('toolu_c171_bash_sharedonly')).toBe(false);
    expect(keptWhenHidden('toolu_c171_edit_fail')).toBe(false); // a failed edit has no change to show: the chip speaks for it
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(true); // tool calls hidden, changes still open
    prefs.showChanges = false;
    expect(prefs.hideTools).toBe(true);
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(false);
    expect(keptWhenHidden('toolu_c171_bash_one')).toBe(true);
    prefs.hideTools = false;
    expect(prefs.showChanges).toBe(false);
    expect(files('toolu_c171_bash_one')[0]?.open).toBe(false);
    expect(toolHasChanges(CHANGES.find((it) => it.id === 'toolu_c171_bash_skipped') as TranscriptItem)).toBe(true);
  });

  it('a failed edit while tool calls are hidden goes on the chip; a failed change that shows does not', () => {
    prefs.hideTools = true;
    mount();
    view.setItems([]);
    const diff: TranscriptDiff = { path: 'a.go', hunks: [{ old_start: 0, old_lines: 0, new_start: 0, new_lines: 1, lines: ['+y'] }] };
    view.applyUpdates([{ id: 'patch', seq: 1, ts: 0, kind: 'tool', tool: { name: 'apply_patch', input_summary: 'a.go', status: 'error', diff } }]);
    expect(($('.tx-busy') as HTMLElement).hidden).toBe(true);
    view.applyUpdates([CHANGES.find((it) => it.id === 'toolu_c171_edit_fail') as TranscriptItem]);
    expect(($('.tx-busy') as HTMLElement).hidden).toBe(false);
    expect($('.tx-busy')?.textContent).toBe('Edit failed');
  });

  it('a change the list cut loads in full through transcript.item, in place; upstream gaps offer nothing', async () => {
    const cut: TranscriptDiff = { path: 'big.ts', truncated: true, op: 'edit', hunks: [{ old_start: 1, old_lines: 3, new_start: 1, new_lines: 3, lines: ['-a', '+b'] }] };
    const whole: TranscriptDiff = { path: 'big.ts', op: 'edit', hunks: [{ old_start: 1, old_lines: 3, new_start: 1, new_lines: 3, lines: ['-a', '+b', '-c', '+d', '-e', '+f'] }] };
    const it: TranscriptItem = { id: 'big', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'big.ts', status: 'ok', diff: cut } };
    mount(async () => ({ ...it, tool: { ...it.tool!, diff: whole } }));
    view.setItems([it, ...CHANGES]);
    expect($$('.tx-chg-op', row('big')).map((e) => e.textContent)).toEqual(['cut']);
    expect($('.tx-chg-cutnote', row('big'))?.textContent).toBe('Cut to fit the list: only the start is shown. Show the whole change');
    // A no_diff overwrite is the source's gap: no link.
    expect($('.tx-link', row('toolu_c171_wr_nodiff'))).toBeNull();
    ($('.tx-chg-cutnote .tx-link', row('big')) as HTMLButtonElement).click();
    await flush();
    expect(host.itemLoads).toEqual([['big', undefined]]);
    expect($('.tx-chg-cutnote', row('big'))).toBeNull();
    expect(files('big')).toEqual([{ path: 'big.ts', op: [], stat: '+3 −3', open: true }]);
    // A later re-render keeps the whole one.
    view.applyUpdates([it]);
    expect(files('big')[0]?.stat).toBe('+3 −3');
  });

  /** An edit of `n` lines, each `+line i` (new lines 1..n). */
  const longDiff = (n: number, extra: Partial<TranscriptDiff> = {}): TranscriptDiff => ({
    path: 'long.ts',
    op: 'edit',
    hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: n, lines: Array.from({ length: n }, (_, i) => `+line ${i + 1}`) }],
    ...extra,
  });
  const lineRows = (id: string) => $$('.tx-diff-body .tx-dl:not(.tx-dh)', row(id));
  const more = (id: string) => $<HTMLButtonElement>('.tx-diff-more .tx-link', row(id));

  it('a diff past 2,000 lines shows the rest a page at a time, in place, keeping the page and its numbers', () => {
    const it: TranscriptItem = { id: 'long', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'long.ts', status: 'ok', diff: longDiff(4500) } };
    mount();
    view.setItems([it]);
    const body = $('.tx-diff-body', row('long')) as HTMLElement;
    expect(lineRows('long')).toHaveLength(2000);
    expect(more('long')?.textContent).toBe('Show next 2,000 lines (2,500 left)');
    more('long')!.click();
    expect($('.tx-diff-body', row('long'))).toBe(body);
    expect(lineRows('long')).toHaveLength(4000);
    expect($$('.tx-dn', lineRows('long')[2000]).map((e) => e.textContent)).toEqual(['', '2001']);
    expect(more('long')?.textContent).toBe('Show next 500 lines (500 left)');
    // A re-render of the row keeps what was shown.
    view.applyUpdates([it]);
    expect(lineRows('long')).toHaveLength(4000);
    more('long')!.focus();
    more('long')!.click();
    expect(lineRows('long')).toHaveLength(4500);
    expect(lineRows('long').at(-1)?.textContent).toBe('4500+line 4500');
    expect(more('long')).toBeNull();
    expect(document.activeElement).toBe($('.tx-diff-body', row('long')));
  });

  it('a cut change loaded whole past 2,000 lines reaches its last line', async () => {
    const it: TranscriptItem = { id: 'big', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'long.ts', status: 'ok', diff: longDiff(300, { truncated: true }) } };
    mount(async () => ({ ...it, tool: { ...it.tool!, diff: longDiff(3000) } }));
    view.setItems([it]);
    expect(more('big')).toBeNull();
    ($('.tx-chg-cutnote .tx-link', row('big')) as HTMLButtonElement).click();
    await flush();
    expect(lineRows('big')).toHaveLength(2000);
    expect(more('big')?.textContent).toBe('Show next 1,000 lines (1,000 left)');
    more('big')!.click();
    expect(lineRows('big')).toHaveLength(3000);
    expect(lineRows('big').at(-1)?.textContent).toBe('3000+line 3000');
  });

  it("a changed file's lines take the focus and scroll with the keys, not the timeline", () => {
    mount();
    view.setItems([{ id: 'long', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'long.ts', status: 'ok', diff: longDiff(100) } }]);
    const body = $('.tx-diff-body', row('long')) as HTMLElement;
    const scroller = $('.tx-scroll') as HTMLElement;
    expect(body.tabIndex).toBe(0);
    expect(body.getAttribute('aria-label')).toBe('Changes to long.ts');
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1500 });
    const seen: string[] = [];
    const outside = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener('keydown', outside);
    const key = (k: string, el: HTMLElement = body) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    try {
      expect(key('PageDown')).toBe(true);
      expect(body.scrollTop).toBe(180);
      key('ArrowDown');
      expect(body.scrollTop).toBe(228);
      key('Home');
      expect(body.scrollTop).toBe(0);
      key(' ');
      expect(body.scrollTop).toBe(180);
      expect(scroller.scrollTop).toBe(0);
      expect(seen).toEqual([]);
      // Elsewhere the timeline keeps its keys.
      expect(key('PageDown', row('long'))).toBe(true);
    } finally {
      document.removeEventListener('keydown', outside);
    }
  });

  it("a diff body the timeline clips: past the body's own end the keys bring its clipped edge into view", () => {
    mount();
    view.setItems([{ id: 'long', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'long.ts', status: 'ok', diff: longDiff(100) } }]);
    const body = $('.tx-diff-body', row('long')) as HTMLElement;
    const scroller = $('.tx-scroll') as HTMLElement;
    // At 200%, a body 600px high, 200px down a 417px timeline: its last 383px below the view. It scrolls 0..1300.
    let inner = 0;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => inner, set: (v: number) => (inner = Math.min(1300, Math.max(0, v))) });
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 900, width: 900, x: 0, y: top, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => rect(0, 417);
    body.getBoundingClientRect = () => rect(200 - scroller.scrollTop, 600);
    const key = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // While the body scrolls, the timeline stays.
    expect(key('PageDown')).toBe(true);
    expect([inner, scroller.scrollTop]).toEqual([180, 0]);
    // End: the body's end, and its bottom edge into the view.
    expect(key('End')).toBe(true);
    expect([inner, scroller.scrollTop]).toEqual([1300, 383]);
    // Home: its start, and its top edge into the view.
    key('Home');
    expect([inner, scroller.scrollTop]).toEqual([0, 200]);
    // At the body's end, ↓ and PageDown move the timeline a step at a time, up to the body's bottom edge, no further.
    scroller.scrollTop = 0;
    inner = 1300;
    key('ArrowDown');
    expect(scroller.scrollTop).toBe(48);
    key('PageDown');
    expect(scroller.scrollTop).toBe(228);
    key('PageDown');
    expect(scroller.scrollTop).toBe(383);
    expect(key('PageDown')).toBe(true);
    expect(scroller.scrollTop).toBe(383);
    // And ↑ at its start, back up to its top edge.
    inner = 0;
    key('ArrowUp');
    expect(scroller.scrollTop).toBe(335);
    key('PageUp');
    expect(scroller.scrollTop).toBe(200);
    expect(inner).toBe(0);
  });

  it('a diff body entirely above or below the view (a resize): the edge a key heads for comes back into it', () => {
    mount();
    view.setItems([{ id: 'long', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'long.ts', status: 'ok', diff: longDiff(100) } }]);
    const body = $('.tx-diff-body', row('long')) as HTMLElement;
    const scroller = $('.tx-scroll') as HTMLElement;
    // A body 300px high (its rows 30px), `at` px down a 417px timeline. It scrolls 0..1300.
    let inner = 0;
    let at = 200;
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => inner, set: (v: number) => (inner = Math.min(1300, Math.max(0, v))) });
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 900, width: 900, x: 0, y: top, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => rect(0, 417);
    body.getBoundingClientRect = () => rect(at - scroller.scrollTop, 300);
    (body.firstElementChild as HTMLElement).getBoundingClientRect = () => rect(at - scroller.scrollTop, 30);
    (body.lastElementChild as HTMLElement).getBoundingClientRect = () => rect(at - scroller.scrollTop + 270, 30);
    const key = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Above (-400..-100), at its end: End brings its bottom edge to the view's, the whole body in.
    scroller.scrollTop = 600;
    inner = 1300;
    expect(key('End')).toBe(true);
    expect(scroller.scrollTop).toBe(83);
    // ↓ a step at a time, back down until its last line shows (-256..44: 14..44), then no further.
    scroller.scrollTop = 600;
    for (const want of [552, 504, 456, 456]) {
      expect(key('ArrowDown')).toBe(true);
      expect(scroller.scrollTop).toBe(want);
    }
    expect(inner).toBe(1300);
    // Its last line in the view, the rest above: ↓ and End leave the timeline.
    key('End');
    expect(scroller.scrollTop).toBe(456);
    // Below (1000..1300), at its start: Home brings its top edge to the view's.
    at = 1000;
    scroller.scrollTop = 0;
    inner = 0;
    expect(key('Home')).toBe(true);
    expect(scroller.scrollTop).toBe(1000);
    // ↑ a step at a time, until its first line shows (top at 417 - 30 or above), then no further.
    scroller.scrollTop = 0;
    for (let i = 0; i < 14; i++) key('ArrowUp');
    expect(scroller.scrollTop).toBe(624);
    expect(inner).toBe(0);
    // Below, at its end, ↓ still goes toward it (its own side), a step at a time.
    scroller.scrollTop = 0;
    inner = 1300;
    key('ArrowDown');
    expect(scroller.scrollTop).toBe(48);
  });

  it('a failed load says so where the link was', async () => {
    const it: TranscriptItem = { id: 'big', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'big.ts', status: 'ok', diff: { path: 'big.ts', truncated: true, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ['-a'] }] } } };
    mount(async () => {
      throw new Error('the transcript moved on');
    });
    view.setItems([it]);
    ($('.tx-chg-cutnote .tx-link') as HTMLButtonElement).click();
    await flush();
    expect($('.tx-chg-cutnote')?.textContent).toBe('Cut to fit the list: only the start is shown. The whole change could not be loaded: the transcript moved on');
  });

  it("a subagent's changes show in its timeline, and load in full with its agent", async () => {
    const cut: TranscriptDiff = { path: 'sub.ts', truncated: true, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ['-a'] }] };
    const inner: TranscriptItem = { id: 'inner', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Bash', input_summary: 'sed', status: 'ok', diff: cut, changes: { paths: ['x.ts'], more_files: 1, shared: true } } };
    mount(async () => ({ ...inner, tool: { ...inner.tool!, diff: { path: 'sub.ts', hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ['-a', '+b'] }] } } }), [inner]);
    view.setItems([{ id: 'agent', seq: 1, ts: 0, kind: 'subagent', subagent: { agent_id: 'abc123', description: 'Fix it', status: 'completed' } }]);
    ($('.tx-sub-row') as HTMLButtonElement).click();
    await flush();
    await flush();
    const nested = $('.tx-nested') as HTMLElement;
    expect($$('.tx-chg-file .tx-diff-path', nested).map((e) => e.textContent)).toEqual(['sub.ts']);
    expect($$('.tx-changes > .tx-chg-note, .tx-chg-more > summary', nested).map((e) => e.textContent)).toEqual(['1 more file changed, no diff recorded', 'Another command ran in this repository at the same time: some of these changes may be its.']);
    ($('.tx-chg-cutnote .tx-link', nested) as HTMLButtonElement).click();
    await flush();
    expect(host.itemLoads).toEqual([['inner', 'abc123']]);
    expect($('.tx-chg-file .tx-diff-stat', nested)?.textContent).toBe('+1 −1');
  });

  it('a restored history renders the same as the live one, with no duplicate changes', () => {
    mount();
    view.setItems(CHANGES.slice(0, 8));
    view.applyUpdates(CHANGES.slice(8));
    const live = $$('.tx-chg-file').map((f) => f.textContent);
    view.setItems(CHANGES);
    expect($$('.tx-chg-file').map((f) => f.textContent)).toEqual(live);
    expect(new Set($$('.tx-chg-file').map((f) => f.dataset.key)).size).toBe(live.length);
  });
});

describe('syntax colours in diff rows (#206)', () => {
  /** Waits until the highlighter has nothing left to do. */
  const settled = () => vi.waitFor(() => expect(diffColoursBusy()).toBe(false), { timeout: 20_000, interval: 5 });
  const cells = (id: string, kind = ':not(.tx-dh)') => $$(`.tx-diff-body .tx-dl${kind} .tx-dt`, row(id));
  const tokens = (dt: HTMLElement) => $$('[class^="hljs-"]', dt).map((s) => [s.className, s.textContent]);
  const PROTO = 'toolu_018mQCao59VwQiRK6L6zHu5h';

  it('rows draw plain, then gain colours in place: same text, the sign kept apart, other rows as they were', async () => {
    mount();
    view.setItems(CHANGES);
    const before = cells(PROTO).map((e) => e.textContent);
    // Drawn before the highlighter loaded: plain, as before.
    expect(cells(PROTO).every((e) => e.childNodes.length === 1 && e.firstChild?.nodeType === Node.TEXT_NODE)).toBe(true);
    await settled();
    expect(cells(PROTO).map((e) => e.textContent)).toEqual(before);
    const add = cells(PROTO, '.tx-add')[0] as HTMLElement;
    expect(add.classList.contains('tx-hl')).toBe(true);
    expect(add.firstElementChild?.outerHTML).toBe('<span class="tx-dsg">+</span>');
    expect(tokens(add)).toEqual([['hljs-comment', '// M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").']]);
    expect(tokens(cells(PROTO, '.tx-add')[1] as HTMLElement)).toContainEqual(['hljs-string', "'transcript.watch'"]);
    // Context rows too (no sign span of their own colour, but their tokens).
    expect(tokens(cells(PROTO, '.tx-ctx')[0] as HTMLElement)).toContainEqual(['hljs-string', "'terminal.watch'"]);
    // The hunk header is not code; Python and TOML are coloured, a file without a known extension is not.
    expect($('.tx-dh .tx-dt', row(PROTO))?.childNodes).toHaveLength(1);
    expect(tokens(cells('toolu_c171_bash_one', '.tx-add')[0] as HTMLElement)).toContainEqual(['hljs-number', '5']);
    expect(cells('toolu_c171_wr_upd2', '.tx-add').every((e) => e.classList.contains('tx-hl'))).toBe(true);
    for (const id of ['toolu_c171_bash_unavail', 'toolu_c171_bash_shared']) expect(cells(id).some((e) => e.classList.contains('tx-hl') || e.childElementCount > 0), id).toBe(false);
  });

  it('a hunk is tokenized as its two sides: a string or comment across rows colours on every row; meta rows stay', async () => {
    const lines = [' const q = `select *', '-  from a', '+  from b', ' `;', '+/* one', '+two */', '\\ No newline at end of file'];
    const it: TranscriptItem = { id: 'sides', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'q.ts', status: 'ok', diff: { path: 'src/q.ts', hunks: [{ old_start: 1, old_lines: 4, new_start: 1, new_lines: 5, lines }] } } };
    mount();
    view.setItems([it]);
    await settled();
    const all = cells('sides');
    expect(all.map((e) => e.textContent)).toEqual(lines);
    expect(tokens(all[1] as HTMLElement)).toEqual([['hljs-string', '  from a']]);
    expect(tokens(all[2] as HTMLElement)).toEqual([['hljs-string', '  from b']]);
    expect(tokens(all[3] as HTMLElement)).toEqual([['hljs-string', '`']]);
    expect(tokens(all[5] as HTMLElement)).toEqual([['hljs-comment', 'two */']]);
    expect((all[6] as HTMLElement).childNodes).toHaveLength(1);
  });

  it('"Show next" pages gain colours when they draw, and only what is drawn is coloured', async () => {
    // Small hunks (each well inside the page's thread budget), 2,100 rows: two pages.
    const hunks = Array.from({ length: 21 }, (_, k) => ({ old_start: k * 200 + 1, old_lines: 0, new_start: k * 200 + 1, new_lines: 100, lines: Array.from({ length: 100 }, (_, i) => `+const v${k}_${i} = ${i};`) }));
    const it: TranscriptItem = { id: 'paged', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'p.ts', status: 'ok', diff: { path: 'p.ts', op: 'create', hunks } } };
    mount();
    view.setItems([it]);
    await settled();
    expect(cells('paged')).toHaveLength(2000);
    expect(cells('paged').every((e) => e.classList.contains('tx-hl'))).toBe(true);
    ($<HTMLButtonElement>('.tx-diff-more .tx-link', row('paged')) as HTMLButtonElement).click();
    const page2 = cells('paged').slice(2000);
    expect(page2).toHaveLength(100);
    expect(page2.some((e) => e.classList.contains('tx-hl'))).toBe(false);
    await settled();
    expect(page2.every((e) => e.classList.contains('tx-hl'))).toBe(true);
    expect((page2.at(-1) as HTMLElement).textContent).toBe('+const v20_99 = 99;');
    expect(tokens(page2.at(-1) as HTMLElement)).toEqual(expect.arrayContaining([['hljs-keyword', 'const'], ['hljs-number', '99']]));
  }, 60_000);

  it('a change loaded whole through transcript.item is coloured in its new rows', async () => {
    const cut: TranscriptDiff = { path: 'w.go', truncated: true, hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ['-a := 1'] }] };
    const whole: TranscriptDiff = { path: 'w.go', hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 2, lines: ['-a := 1', '+a := "two"', '+return a'] }] };
    const it: TranscriptItem = { id: 'whole', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'w.go', status: 'ok', diff: cut } };
    mount(async () => ({ ...it, tool: { ...it.tool!, diff: whole } }));
    view.setItems([it]);
    await settled();
    const old = cells('whole')[0] as HTMLElement;
    ($('.tx-chg-cutnote .tx-link', row('whole')) as HTMLButtonElement).click();
    await flush();
    expect(old.isConnected).toBe(false);
    await settled();
    expect(cells('whole').map((e) => e.textContent)).toEqual(['-a := 1', '+a := "two"', '+return a']);
    expect(tokens(cells('whole')[1] as HTMLElement)).toContainEqual(['hljs-string', '"two"']);
    expect(tokens(cells('whole')[2] as HTMLElement)).toContainEqual(['hljs-keyword', 'return']);
  });

  it('rows that left the page before their colours were ready are not touched; re-rendered rows get their own', async () => {
    const it: TranscriptItem = { id: 'gone', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Edit', input_summary: 'g.ts', status: 'ok', diff: { path: 'g.ts', hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ['-let a = 1;', '+let a = 2;'] }] } } };
    mount();
    view.setItems([it]);
    const first = cells('gone');
    // A live update re-renders the row before the highlighter ran.
    view.applyUpdates([{ ...it }]);
    const second = cells('gone');
    expect(second[0]).not.toBe(first[0]);
    await settled();
    expect(first.every((e) => e.childNodes.length === 1)).toBe(true);
    expect(second.every((e) => e.classList.contains('tx-hl'))).toBe(true);
    // A row whose text changed under it is left alone.
    const third: TranscriptItem = { ...it, id: 'gone2' };
    view.applyUpdates([third]);
    const cell = cells('gone2')[1] as HTMLElement;
    cell.textContent = '+something else';
    await settled();
    expect(cell.textContent).toBe('+something else');
    expect(cell.classList.contains('tx-hl')).toBe(false);
  });

  it('a hunk past the page thread budget waits for the worker; with none (here) it stays plain', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `+export const value${i} = 'a fairly long line ${i}';`);
    const it: TranscriptItem = { id: 'huge', seq: 1, ts: 0, kind: 'tool', tool: { name: 'Write', input_summary: 'h.ts', status: 'ok', diff: { path: 'h.ts', op: 'create', hunks: [{ old_start: 0, old_lines: 0, new_start: 1, new_lines: 1500, lines }] } } };
    expect(lines.join('\n').length).toBeGreaterThan(MAIN_BUDGET);
    mount();
    view.setItems([it]);
    await settled();
    expect(cells('huge').some((e) => e.classList.contains('tx-hl'))).toBe(false);
  });
});

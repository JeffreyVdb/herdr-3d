// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptDiff, TranscriptItem } from '../net/protocol';
import { ViewPrefs } from '../ui/themePrefs';
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

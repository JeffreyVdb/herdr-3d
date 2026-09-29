import type { Changes } from '../net/protocol';
import { changesView, noDiffReason, numberLines, splitPath, type ChangesView, type LineKind } from '../world/changes';
import { CHIP_TEXT } from '../world/derive';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';

/**
 * C, the Changes panel (M5): a read-only side panel over the right of the
 * scene (the floor stays in view) with what a worker's checkout holds
 * against its base (`worker.changes`): branch, upstream, base, the changed
 * files (staged / unstaged / untracked / committed, +/−) and the diff of
 * the selected one, drawn a screenful at a time so a 256 KiB diff stays
 * quick. Keyboard: ↑ ↓ Home End pick a file, Enter or → reads its diff,
 * ← back to the list, R refreshes, Esc (or C) closes.
 */

export type ChangesState = 'loading' | 'ready' | 'error';

/** What the Changes panel shows (test hook, via `window.__h3d.panel()`). */
export interface ChangesSummary {
  kind: 'changes';
  id: string;
  name: string;
  state: ChangesState;
  /** The error code when it failed (`not_a_repo`, `changes_failed`, …). */
  code: string | null;
  branch: string | null;
  upstream: string | null;
  base: string | null;
  stat: string | null;
  truncated: string | null;
  files: Array<{ path: string; chips: string[]; insertions: number; deletions: number; selected: boolean }>;
  /** The selected file's diff: its line count, the lines on screen and why there is none. */
  diff: { path: string; lines: number; shown: string[]; none: string | null } | null;
  status: string;
  error: boolean;
  confirm: null;
}

/** A branch: two commits and the fork between them. */
const BRANCH = '<circle cx="7" cy="5.5" r="2.2"/><circle cx="7" cy="18.5" r="2.2"/><circle cx="17" cy="8" r="2.2"/><path d="M7 7.7v8.6M17 10.2c0 4-4 4.3-9.3 6.4"/>';
const REFRESH = '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.5 4.5v4h-4"/>';
const AHEAD = '<path d="M12 18.5v-12M7 11l5-5 5 5"/>';
const BEHIND = '<path d="M12 5.5v12M7 13l5 5 5-5"/>';

/** Diff line height (px), fixed: the diff is drawn a window at a time. */
const LINE_H = 18;
/** Lines drawn beyond the visible ones, each side. */
const OVERSCAN = 30;

export class ChangesPanel {
  private readonly dialog = h('dialog', { class: 'changes', 'aria-labelledby': 'cp-title', 'aria-describedby': 'cp-sub' });
  private readonly head = h('header', { class: 'cp-head' });
  private readonly body = h('div', { class: 'cp-body' });
  private readonly statusEl = h('p', { class: 'cp-status', role: 'status' });
  private id = '';
  private name = '';
  private state: ChangesState = 'loading';
  private code: string | null = null;
  private message = '';
  private data: Changes | null = null;
  private view: ChangesView | null = null;
  private selected = 0;
  private gen = 0;
  private headKey = '';
  /** The diff pane's virtual scroller, when a file with a diff is shown. */
  private scroller: { el: HTMLElement; win: HTMLElement; lines: string[]; kinds: LineKind[]; nums: Array<[number | null, number | null]>; first: number; last: number } | null = null;
  private raf = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: DialogHost & { /** Focus back to the game (the panel closed). */ blur(): void },
  ) {
    this.statusEl.hidden = true;
    this.dialog.append(this.head, this.body, this.statusEl);
    this.dialog.addEventListener('keydown', (e) => this.onKey(e));
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** The worker it shows (null when closed). */
  get worker(): string | null {
    return this.dialog.open ? this.id : null;
  }

  /** Keys typed in the panel are the panel's, not the game's. */
  owns(target: EventTarget | null): boolean {
    return target instanceof Node && this.dialog.contains(target);
  }

  close(): void {
    if (!this.dialog.open) return;
    const inside = this.owns(document.activeElement);
    this.dialog.close();
    this.gen++;
    this.scroller = null;
    if (inside) this.host.blur();
  }

  open(workerId: string): void {
    const v = this.host.store.workerView(workerId);
    if (!v) return;
    const same = this.dialog.open && this.id === workerId;
    this.id = workerId;
    this.name = v.name;
    if (!this.dialog.open) this.dialog.show();
    if (!same) {
      this.data = null;
      this.view = null;
      this.selected = 0;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    const gen = ++this.gen;
    this.state = 'loading';
    this.code = null;
    this.setStatus(this.data ? 'Refreshing…' : '');
    this.render();
    this.focusList();
    if (this.host.unsupported('worker.changes')) {
      this.fail('unknown_command', '');
      return;
    }
    const r = await this.host.send('worker.changes', { id: this.id });
    if (gen !== this.gen || !this.dialog.open) return;
    if (!r.ok) {
      this.fail(r.code, r.message);
      return;
    }
    const keep = this.view?.files[this.selected]?.path;
    this.data = r.data as Changes;
    this.view = changesView(this.data);
    const again = keep ? this.view.files.findIndex((f) => f.path === keep) : -1;
    // The first file with a diff to read, unless the one you had is still there.
    this.selected = again >= 0 ? again : Math.max(0, this.view.files.findIndex((f) => !noDiffReason(f)));
    this.state = 'ready';
    this.setStatus('');
    this.render();
    this.focusList();
  }

  private fail(code: string, message: string): void {
    this.state = 'error';
    this.code = code;
    this.message = code === 'invalid_state' ? `${this.name}’s floor is asleep: wake it from the elevator (L) to read its changes.` : failureText('worker.changes', code, message, { worker: this.name });
    this.render();
  }

  /** The world changed: the header's status, or the worker left. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (!this.host.store.workers.has(this.id)) {
      this.setStatus(`${this.name} has left the floor: this is what its checkout held.`);
    }
    this.renderHead();
  }

  private setStatus(msg: string): void {
    this.statusEl.hidden = !msg;
    this.statusEl.textContent = msg;
  }

  private renderHead(): void {
    const v = this.host.store.workerView(this.id);
    const cwd = this.data?.cwd ?? v?.worker.cwd ?? '';
    const key = JSON.stringify([this.name, cwd, v?.display ?? null, this.state]);
    if (key === this.headKey) return;
    this.headKey = key;
    const had = document.activeElement instanceof HTMLElement && this.head.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const nodes: Node[] = [
      h('div', { class: 'cp-plate', 'aria-hidden': 'true' }, icon(BRANCH)),
      h('div', { class: 'cp-titles' }, h('h2', { id: 'cp-title' }, `Changes · ${this.name}`), h('p', { id: 'cp-sub', title: cwd }, h('span', { dir: 'ltr' }, cwd || 'no folder'))),
    ];
    if (v) nodes.push(h('span', { class: `tape tape--${v.display}` }, CHIP_TEXT[v.display]));
    nodes.push(
      h(
        'button',
        { class: 'btn btn--icon', 'data-key': 'refresh', 'aria-label': 'Refresh', title: 'Refresh (R)', 'aria-disabled': this.state === 'loading' ? 'true' : null, onclick: () => this.state !== 'loading' && void this.load() },
        icon(REFRESH),
      ),
      h('button', { class: 'btn btn--icon', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.head.replaceChildren(...nodes);
    if (had) this.head.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
  }

  private render(): void {
    this.renderHead();
    const v = this.view;
    if (this.state === 'error') {
      const retry = this.code !== 'unknown_command' && this.code !== 'not_a_repo';
      this.scroller = null;
      this.body.replaceChildren(
        h(
          'div',
          { class: 'cp-empty cp-empty--error', role: 'alert' },
          h('p', {}, this.message),
          retry ? h('button', { class: 'btn btn--sm', 'data-key': 'retry', onclick: () => void this.load() }, 'Try again') : null,
        ),
      );
      return;
    }
    if (!v) {
      this.scroller = null;
      this.body.replaceChildren(h('div', { class: 'cp-skeleton', 'aria-label': `Reading ${this.name}’s checkout…` }, h('i'), h('i'), h('i'), h('i')));
      return;
    }
    const meta = h(
      'dl',
      { class: 'cp-meta' },
      h('dt', {}, 'Branch'),
      h('dd', {}, h('code', { class: 'cp-branch' }, v.branch)),
      h('dt', {}, 'Upstream'),
      h(
        'dd',
        {},
        this.data?.upstream
          ? h(
              'span',
              { class: 'cp-track', title: v.upstream },
              h('code', {}, this.data.upstream),
              h('span', { class: 'cp-ab', 'aria-label': `${v.ahead} ahead` }, icon(AHEAD), String(v.ahead)),
              h('span', { class: 'cp-ab', 'aria-label': `${v.behind} behind` }, icon(BEHIND), String(v.behind)),
            )
          : v.upstream,
      ),
      h('dt', {}, 'Against'),
      h('dd', {}, h('code', {}, v.base)),
    );
    const nodes: Node[] = [meta, h('p', { class: 'cp-stat' }, v.stat)];
    if (v.truncated) nodes.push(h('div', { class: 'dd-callout cp-cut', 'data-level': 'warn', role: 'note' }, h('p', {}, v.truncated)));
    if (!v.files.length) {
      this.scroller = null;
      nodes.push(h('div', { class: 'cp-empty' }, h('p', {}, `No changes against ${this.data?.base?.ref ?? 'HEAD'}: ${this.name}’s working tree is clean and its branch has nothing new.`)));
      this.body.replaceChildren(...nodes);
      return;
    }
    const list = h('ul', {
      class: 'cp-files',
      role: 'listbox',
      tabindex: 0,
      'data-key': 'files',
      'aria-label': 'Changed files',
      'aria-activedescendant': `cp-file-${this.selected}`,
    });
    v.files.forEach((f, i) => {
      const p = splitPath(f.path);
      list.append(
        h(
          'li',
          {
            id: `cp-file-${i}`,
            role: 'option',
            class: 'cp-file',
            'aria-selected': i === this.selected ? 'true' : 'false',
            title: `${f.path}: ${f.state.words}`,
            onclick: () => this.select(i, true),
          },
          h('span', { class: 'cp-chips' }, ...f.state.chips.map((c) => h('span', { class: `cp-chip cp-chip--${c.kind}` }, c.text))),
          // Cut from the left: the file name is the part to keep.
          h('span', { class: 'cp-path' }, h('span', { dir: 'ltr' }, p.dir ? h('span', { class: 'cp-dir' }, p.dir) : null, h('span', { class: 'cp-base' }, p.base))),
          f.binary ? h('span', { class: 'cp-counts' }, 'bin') : h('span', { class: 'cp-counts' }, h('span', { class: 'cp-ins' }, `+${f.insertions}`), h('span', { class: 'cp-del' }, `−${f.deletions}`)),
        ),
      );
    });
    nodes.push(h('div', { class: 'cp-main' }, list, this.diffPane()));
    this.body.replaceChildren(...nodes);
    this.paintDiff();
  }

  /** The selected file's diff (or why there is none), drawn a window of lines at a time. */
  private diffPane(): HTMLElement {
    const f = this.view?.files[this.selected];
    const pane = h('section', { class: 'cp-diff', 'aria-label': f ? `Diff of ${f.path}` : 'Diff' });
    if (!f) return pane;
    pane.append(h('header', { class: 'cp-diff-head' }, h('code', {}, f.path), h('span', {}, f.state.words)));
    const none = noDiffReason(f);
    if (none || !f.diff) {
      this.scroller = null;
      pane.append(h('p', { class: 'cp-nodiff' }, none ?? 'No diff for this file.'));
      return pane;
    }
    const lines = f.diff.lines;
    const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const el = h('div', { class: 'cp-scroll', tabindex: 0, 'data-key': 'diff', role: 'region', 'aria-label': `${f.path}, ${lines.length} lines` });
    const spacer = h('div', { class: 'cp-spacer', style: `height:${lines.length * LINE_H}px;min-width:calc(${widest}ch + 96px)` });
    const win = h('div', { class: 'cp-window' });
    spacer.append(win);
    el.append(spacer);
    el.addEventListener('scroll', () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.paintDiff();
      });
    });
    this.scroller = { el, win, lines, kinds: f.diff.kinds, nums: numberLines(f.diff), first: -1, last: -1 };
    pane.append(el);
    return pane;
  }

  /** Draws the diff lines in view (and a margin), when the view moved. */
  private paintDiff(): void {
    const s = this.scroller;
    if (!s || !s.el.isConnected) return;
    const height = s.el.clientHeight || 480;
    const first = Math.max(0, Math.floor(s.el.scrollTop / LINE_H) - OVERSCAN);
    const last = Math.min(s.lines.length, Math.ceil((s.el.scrollTop + height) / LINE_H) + OVERSCAN);
    if (first === s.first && last === s.last) return;
    s.first = first;
    s.last = last;
    s.win.style.transform = `translateY(${first * LINE_H}px)`;
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const [o, n] = s.nums[i] ?? [null, null];
      rows.push(
        h(
          'div',
          { class: `cp-line cp-line--${s.kinds[i] ?? 'ctx'}` },
          h('span', { class: 'cp-num', 'aria-hidden': 'true' }, o === null ? '' : String(o)),
          h('span', { class: 'cp-num', 'aria-hidden': 'true' }, n === null ? '' : String(n)),
          h('span', { class: 'cp-code' }, s.lines[i] ?? ''),
        ),
      );
    }
    s.win.replaceChildren(...rows);
  }

  private select(i: number, focusList = false): void {
    const n = this.view?.files.length ?? 0;
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, i));
    if (next === this.selected && !focusList) return;
    this.selected = next;
    this.render();
    this.focusList();
    this.body.querySelector(`#cp-file-${next}`)?.scrollIntoView({ block: 'nearest' });
  }

  private focusList(): void {
    const list = this.body.querySelector<HTMLElement>('.cp-files');
    (list ?? this.body.querySelector<HTMLElement>('[data-key="retry"]') ?? this.head.querySelector<HTMLElement>('[data-key="close"]'))?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const inList = e.target instanceof HTMLElement && e.target.classList.contains('cp-files');
    const inDiff = e.target instanceof HTMLElement && e.target.classList.contains('cp-scroll');
    if (e.key === 'Escape' || e.code === 'KeyC') {
      e.preventDefault();
      this.close();
    } else if (e.code === 'KeyR' && this.state !== 'loading') {
      e.preventDefault();
      void this.load();
    } else if (inList && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const n = this.view?.files.length ?? 0;
      this.select(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : this.selected + (e.key === 'ArrowDown' ? 1 : -1), true);
    } else if (inList && (e.key === 'Enter' || e.key === 'ArrowRight')) {
      e.preventDefault();
      this.body.querySelector<HTMLElement>('.cp-scroll')?.focus();
    } else if (inDiff && e.key === 'ArrowLeft' && (e.target as HTMLElement).scrollLeft === 0) {
      e.preventDefault();
      this.focusList();
    }
    // Everything else stays in the panel: the game does not walk while you read.
    e.stopPropagation();
  }

  summary(): ChangesSummary | null {
    if (!this.dialog.open) return null;
    const v = this.view;
    const f = v?.files[this.selected];
    const s = this.scroller;
    return {
      kind: 'changes',
      id: this.id,
      name: this.name,
      state: this.state,
      code: this.code,
      branch: v?.branch ?? null,
      upstream: v?.upstream ?? null,
      base: v?.base ?? null,
      stat: v?.stat ?? null,
      truncated: v?.truncated ?? null,
      files: (v?.files ?? []).map((x, i) => ({ path: x.path, chips: x.state.chips.map((c) => c.text), insertions: x.insertions, deletions: x.deletions, selected: i === this.selected })),
      diff: f ? { path: f.path, lines: f.diff?.lines.length ?? 0, shown: s ? s.lines.slice(s.first, s.last) : [], none: noDiffReason(f) } : null,
      status: this.state === 'error' ? this.message : (this.statusEl.textContent ?? ''),
      error: this.state === 'error',
      confirm: null,
    };
  }
}

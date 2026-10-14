import './handoff.css';
import type { HandoffEntry, HandoffGetAck, HandoffListAck, HandoffLLMProvenance } from '../net/protocol';
import { snippetRuns, sourceWord } from '../world/handoff';
import { redactionText } from '../world/handoffLlm';
import { setMarkdown } from './boards/markdown';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';

/**
 * #223: the floor's filing cabinet, opened at its drawer (E at the cabinet). Its handoffs newest first, or a search's
 * matches by relevance with the matching words of each body; one handoff's Markdown, sanitised (the boards' allowlist:
 * nothing in it runs or loads), with where it came from; Copy path, Delete (after a confirm, to the trash) and Hire
 * from handoff, which opens the reviewed hire with its folder, harness and model and a task that reads it. Snippets
 * are text runs with `<mark>`s built as DOM nodes: nothing from a file or a snippet is parsed as HTML.
 */

export interface CabinetHost extends DialogHost {
  copy(text: string): Promise<boolean>;
  /** Hire from handoff: the reviewed hire, seeded from it (the host checks the floor has a free desk). */
  hireFrom(e: HandoffEntry): void;
}

/** What the cabinet shows (test hook `window.__h3d.cabinet()`). */
export interface CabinetSummary {
  open: boolean;
  floor: string;
  query: string;
  rows: Array<{ id: number; title: string; worker: string; source: string; snippet: string }>;
  selected: number | null;
  body: string;
  confirming: boolean;
  status: string;
  error: boolean;
}

const SEARCH_MS = 180;
const day = (ms: number) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class Cabinet {
  private readonly dialog = h('dialog', { class: 'cab', 'aria-labelledby': 'cab-title', 'aria-describedby': 'cab-sub' });
  private readonly head = h('header', { class: 'cab-head' });
  private readonly search = h('input', { type: 'search', class: 'cab-search', id: 'cab-search', placeholder: 'Search titles, workers, branches and text', 'aria-label': 'Search the cabinet', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  private readonly list = h('ol', { class: 'cab-list', 'aria-label': 'Handoffs' });
  private readonly view = h('section', { class: 'cab-view', 'aria-live': 'polite', 'aria-label': 'Handoff' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private floor = '';
  private rows: HandoffEntry[] = [];
  private selected: HandoffEntry | null = null;
  private body = '';
  /** #9: the selected LLM handoff's provenance (null: none, or another source). */
  private llm: HandoffLLMProvenance | null = null;
  private confirming = false;
  private loading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listGen = 0;
  private getGen = 0;
  private statusText = '';
  private statusError = false;
  private seenVersion = -1;
  private pick: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: CabinetHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    const bar = h('div', { class: 'cab-bar' }, h('label', { class: 'cab-find', for: 'cab-search' }, icon('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'), this.search));
    const panes = h('div', { class: 'cab-panes' }, h('div', { class: 'cab-drawer' }, this.list), this.view);
    this.dialog.append(this.head, bar, panes, h('footer', { class: 'cab-foot' }, this.statusEl, this.alertEl));
    this.dialog.addEventListener('close', () => {
      this.listGen++;
      this.getGen++;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    });
    // Esc in the delete confirm steps back; it does not close the cabinet. In the search it clears the search first.
    this.dialog.addEventListener('cancel', (e) => {
      if (this.confirming) {
        e.preventDefault();
        this.confirming = false;
        this.renderView();
        this.view.querySelector<HTMLElement>('[data-key="delete"]')?.focus();
      } else if (document.activeElement === this.search && this.search.value) {
        e.preventDefault();
        this.search.value = '';
        this.query();
      }
    });
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    this.search.addEventListener('input', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.query(), SEARCH_MS);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        this.list.querySelector<HTMLElement>('.cab-row')?.focus();
      }
    });
    this.list.addEventListener('keydown', (e) => {
      const rows = [...this.list.querySelectorAll<HTMLElement>('.cab-row')];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -2;
      if (to === -2) return;
      e.preventDefault();
      if (to < 0) this.search.focus();
      else rows[Math.min(to, rows.length - 1)]?.focus();
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Opens a floor's drawer (`select`: that handoff, once listed). */
  open(floor: string, select?: number): void {
    this.floor = floor;
    this.rows = [];
    this.selected = null;
    this.body = '';
    this.llm = null;
    this.confirming = false;
    this.pick = select ?? null;
    this.search.value = '';
    this.setStatus('');
    this.seenVersion = this.host.store.handoffs.version;
    this.renderHead();
    this.renderList();
    this.renderView();
    if (!this.dialog.open) this.dialog.showModal();
    this.search.focus();
    this.query();
  }

  /** The world changed: a handoff was filed or deleted somewhere: the drawer is read again. */
  refresh(): void {
    if (!this.dialog.open) return;
    const v = this.host.store.handoffs.version;
    if (v === this.seenVersion) return;
    this.seenVersion = v;
    this.renderHead();
    this.query();
  }

  private renderHead(): void {
    const n = this.host.store.handoffs.count(this.floor);
    this.head.replaceChildren(
      h('div', { class: 'cab-plate', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'cab-title' }, 'Filing cabinet'), h('p', { id: 'cab-sub' }, `${this.floor} · ${n === 1 ? '1 handoff' : `${n} handoffs`}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
  }

  private query(): void {
    this.timer = null;
    void this.load(this.search.value);
  }

  private async load(q: string): Promise<void> {
    const gen = ++this.listGen;
    this.loading = true;
    this.renderList();
    const r = await this.host.send('handoff.list', { floor: this.floor, ...(q.trim() ? { q } : {}) });
    if (gen !== this.listGen || !this.dialog.open) return;
    this.loading = false;
    if (!r.ok) {
      this.rows = [];
      this.setStatus(failureText('handoff.list', r.code, r.message, { floor: this.floor }), true);
      this.renderList();
      return;
    }
    if (this.statusError) this.setStatus('');
    this.rows = (r.data as HandoffListAck).handoffs ?? [];
    this.renderList();
    const want = this.pick ?? this.selected?.id ?? null;
    this.pick = null;
    // The one asked for, else the one shown, else the first: the reading pane is never empty while the drawer is not.
    const keep = (want !== null ? this.rows.find((e) => e.id === want) : undefined) ?? (this.selected ? undefined : this.rows[0]);
    if (keep) void this.show(keep, false);
    else if (this.selected && !this.rows.some((e) => e.id === this.selected?.id) && !q.trim()) {
      this.selected = null;
      this.renderView();
    }
  }

  private renderList(): void {
    if (this.loading && !this.rows.length) {
      this.list.replaceChildren(h('li', { class: 'cab-empty' }, 'Opening the drawer…'));
      return;
    }
    if (!this.rows.length) {
      const q = this.search.value.trim();
      this.list.replaceChildren(
        h('li', { class: 'cab-empty' }, q ? `Nothing matches “${q}”. Search looks for whole words and the start of the last one.` : 'The drawer is empty. File a worker’s last reply from its conversation (Handoff) or with F at the worker.'),
      );
      return;
    }
    this.list.replaceChildren(
      ...this.rows.map((e) => {
        const snippet = e.snippet ? h('span', { class: 'cab-snippet' }, ...snippetRuns(e.snippet).map((r) => (r.hit ? h('mark', {}, r.text) : document.createTextNode(r.text)))) : null;
        const current = this.selected?.id === e.id;
        return h(
          'li',
          {},
          h(
            'button',
            { class: 'cab-row', 'data-id': String(e.id), 'aria-current': current ? 'true' : null, onclick: () => void this.show(e, true) },
            h('span', { class: 'cab-row-title' }, e.title),
            h('span', { class: 'cab-row-meta' }, `${e.worker_name} · ${day(e.created_at)} ${time(e.created_at)}`, h('span', { class: 'cab-source', 'data-source': e.source }, sourceWord(e.source))),
            e.branch ? h('code', { class: 'cab-row-branch' }, e.branch) : null,
            snippet,
          ),
        );
      }),
    );
  }

  private async show(e: HandoffEntry, focus: boolean): Promise<void> {
    const gen = ++this.getGen;
    this.selected = e;
    this.confirming = false;
    this.body = '';
    this.llm = null;
    this.renderList();
    this.renderView(true);
    const r = await this.host.send('handoff.get', { id: e.id });
    if (gen !== this.getGen || !this.dialog.open) return;
    if (!r.ok) {
      this.setStatus(failureText('handoff.get', r.code, r.message, { floor: this.floor }), true);
      this.renderView();
      return;
    }
    const a = r.data as HandoffGetAck;
    this.selected = a.handoff;
    this.body = a.body;
    this.llm = a.llm ?? null;
    this.renderView();
    if (focus) this.view.querySelector<HTMLElement>('[data-key="copy"]')?.focus();
  }

  private renderView(loading = false): void {
    const e = this.selected;
    if (!e) {
      this.view.replaceChildren(h('p', { class: 'cab-empty' }, this.rows.length ? 'Pick a handoff to read it.' : 'Nothing to read yet.'));
      return;
    }
    const meta = h(
      'dl',
      { class: 'ho-prov' },
      h('dt', {}, 'Filed'),
      h('dd', {}, `${day(e.created_at)} ${time(e.created_at)}`),
      h('dt', {}, 'Worker'),
      h('dd', {}, `${e.worker_name}${e.label && e.label !== e.worker_name ? ` (${e.label})` : ''}${e.harness ? ` · ${[e.harness, e.model].filter(Boolean).join(' · ')}` : ''}`),
      e.branch ? h('dt', {}, 'Branch') : null,
      e.branch ? h('dd', {}, h('code', {}, e.branch)) : null,
      h('dt', {}, 'Source'),
      h('dd', { 'data-hook': 'cab-source' }, sourceWord(e.source), e.source === 'llm' && this.llm?.model ? ` · ${this.llm.model}${this.llm.host ? ` at ${this.llm.host}` : ''}` : ''),
      // #9: what an LLM handoff was written from, and with which prompt: provenance, never a claim it is right.
      e.source === 'llm' && this.llm ? h('dt', {}, 'Written from') : null,
      e.source === 'llm' && this.llm
        ? h(
            'dd',
            { 'data-hook': 'cab-llm' },
            [this.llm.coverage, this.llm.prompt_version ? `prompt ${this.llm.prompt_version}` : '', redactionText(this.llm.redactions) ? `scrubbed: ${redactionText(this.llm.redactions)}` : ''].filter(Boolean).join(' · ') || 'the worker’s conversation',
          )
        : null,
      h('dt', {}, 'File'),
      h('dd', {}, h('code', { class: 'ho-path' }, e.path)),
    );
    const actions = this.confirming
      ? h(
          'div',
          { class: 'cab-confirm', role: 'group', 'aria-labelledby': 'cab-confirm-q' },
          h('p', { id: 'cab-confirm-q' }, `Move “${e.title}” to the trash? It leaves the cabinet; the file goes to .trash in the handoff folder.`),
          h('div', { class: 'cab-actions' }, h('button', { class: 'btn', 'data-key': 'keep', onclick: () => ((this.confirming = false), this.renderView(), this.view.querySelector<HTMLElement>('[data-key="delete"]')?.focus()) }, 'Keep it'), h('button', { class: 'btn btn--danger', 'data-key': 'confirm-delete', onclick: () => void this.remove(e) }, 'Move to trash')),
        )
      : h(
          'div',
          { class: 'cab-actions' },
          h('button', { class: 'btn btn--sm', 'data-key': 'copy', onclick: () => void this.copy(e.path) }, 'Copy path'),
          h('button', { class: 'btn btn--sm', 'data-key': 'hire', title: 'Hire a worker that reads this handoff and goes on', onclick: () => this.host.hireFrom(e) }, 'Hire from handoff'),
          h('button', { class: 'btn btn--sm btn--danger-quiet', 'data-key': 'delete', onclick: () => ((this.confirming = true), this.renderView(), this.view.querySelector<HTMLElement>('[data-key="keep"]')?.focus()) }, icon(ICON.trash), 'Delete'),
        );
    const doc = h('article', { class: 'cab-doc', 'data-hook': 'cab-doc' });
    if (loading) doc.append(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    else setMarkdown(doc, this.body);
    this.view.replaceChildren(h('h3', { class: 'cab-doc-title' }, e.title), meta, actions, doc);
  }

  private async copy(path: string): Promise<void> {
    const ok = await this.host.copy(path);
    this.setStatus(ok ? 'Path copied.' : 'The browser did not allow copying: select the path and copy it.', !ok);
  }

  private async remove(e: HandoffEntry): Promise<void> {
    const r = await this.host.send('handoff.delete', { id: e.id, confirm: true });
    if (!this.dialog.open) return;
    this.confirming = false;
    if (!r.ok) {
      this.setStatus(failureText('handoff.delete', r.code, r.message, { floor: this.floor }), true);
      this.renderView();
      return;
    }
    this.setStatus(`Moved “${e.title}” to the trash.`);
    this.selected = null;
    this.body = '';
    this.llm = null;
    this.rows = this.rows.filter((x) => x.id !== e.id);
    this.renderList();
    this.renderView();
    this.list.querySelector<HTMLElement>('.cab-row')?.focus();
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  summary(): CabinetSummary {
    return {
      open: this.dialog.open,
      floor: this.floor,
      query: this.search.value,
      rows: this.rows.map((e) => ({ id: e.id, title: e.title, worker: e.worker_name, source: e.source, snippet: e.snippet ?? '' })),
      selected: this.selected?.id ?? null,
      body: this.body,
      confirming: this.confirming,
      status: this.statusText,
      error: this.statusError,
    };
  }
}

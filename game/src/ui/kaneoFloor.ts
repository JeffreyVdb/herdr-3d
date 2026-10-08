import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, KaneoLink, KaneoProject, KaneoWorkspace } from '../net/protocol';
import { kaneoFailureText, LatestOnly, type KaneoBook } from '../world/kaneo';
import { h } from './dom';

/** What a floor's Kaneo pickers need. */
export interface KaneoPickerHost {
  book: KaneoBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** How long a workspace has to stay picked before its projects are asked for (default 200 ms; tests use 0). */
  debounceMs?: number;
}

type ListState<T> = { s: 'idle' } | { s: 'loading' } | { s: 'ready'; items: T[] } | { s: 'error'; code: string; message: string };

/**
 * #184: a floor's Kaneo workspace and project, as two dropdowns fetched through the bridge with the saved
 * connection (`kaneo.workspaces`, `kaneo.projects`): names shown, ids kept, no id ever typed. The workspace starts
 * at the floor's own (else the bridge's default); changing it clears the project and asks for the new list, and only
 * the newest list lands (an earlier workspace's late answer never restores its project). A project is never picked
 * for you. Loading, empty, access denied and failed lists each say so, a failed one with Retry. Nothing is asked of
 * Kaneo until the floor is switched to Kaneo (`activate`). The lists belong to the connection they were read with
 * (its `generation`): a connection saved, replaced or cleared meanwhile drops them and any answer still on its way,
 * and an active picker asks the new one (so a form opened before Kaneo was connected loads once it is). A list whose
 * `generation` is not the shown connection's is dropped too.
 */
export class KaneoPicker {
  readonly el: HTMLElement;
  readonly workspaceSelect = h('select', { 'data-key': 'kaneo-ws' });
  readonly projectSelect = h('select', { 'data-key': 'kaneo-project' });
  /** The hints under each dropdown (the floor form shows its errors there too). */
  readonly workspaceHint = h('p', { class: 'field-hint', id: 'set-kaneoWorkspace-hint', role: 'status' });
  readonly projectHint = h('p', { class: 'field-hint', id: 'set-kaneoProject-hint', role: 'status' });
  private readonly retry = h('button', { class: 'btn btn--sm', 'data-key': 'kaneo-retry', hidden: true }, 'Retry');
  private readonly notConnected = h('p', { class: 'field-hint kaneo-off' });

  private ws: string;
  private project: string;
  private workspaces: ListState<KaneoWorkspace> = { s: 'idle' };
  private projects: ListState<KaneoProject> = { s: 'idle' };
  private readonly wsSeq = new LatestOnly();
  private readonly projSeq = new LatestOnly();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  /** The connection the lists are of ('' while there is none). */
  private conn: string;
  private readonly off: () => void;

  constructor(
    private readonly host: KaneoPickerHost,
    private readonly saved: KaneoLink | null,
    initialWorkspace: string,
    initialProject: string,
    private readonly changed: () => void = () => {},
  ) {
    this.ws = initialWorkspace;
    this.project = initialProject;
    const field = (key: string, label: string, control: HTMLSelectElement, hint: HTMLElement) => {
      control.id = `set-${key}`;
      control.name = key;
      control.setAttribute('aria-describedby', hint.id);
      return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint);
    };
    this.el = h(
      'div',
      { class: 'kaneo-pick' },
      this.notConnected,
      h('div', { class: 'field-grid field-grid--kaneo' }, field('kaneoWorkspace', 'Workspace', this.workspaceSelect, this.workspaceHint), field('kaneoProject', 'Project', this.projectSelect, this.projectHint)),
      this.retry,
    );
    this.workspaceSelect.addEventListener('change', () => this.pickWorkspace(this.workspaceSelect.value));
    this.projectSelect.addEventListener('change', () => {
      this.project = this.projectSelect.value;
      this.changed();
    });
    this.retry.addEventListener('click', () => {
      if (this.workspaces.s !== 'ready') this.loadWorkspaces();
      else this.loadProjects(0);
    });
    this.conn = this.connection();
    this.off = host.book.onChange(() => {
      const conn = this.connection();
      if (conn !== this.conn) {
        this.conn = conn;
        this.reset();
        if (this.active && conn) this.loadWorkspaces();
      } else if (this.active && conn && this.workspaces.s === 'error' && this.workspaces.code === 'not_configured') this.loadWorkspaces();
      this.render();
    });
    this.render();
  }

  get workspace(): string {
    return this.ws;
  }

  get projectId(): string {
    return this.project;
  }

  /** The floor uses Kaneo now: the lists are asked for (once; Retry asks again). */
  activate(): void {
    this.active = true;
    if (this.workspaces.s === 'idle' && this.host.book.connected) this.loadWorkspaces();
    this.render();
  }

  dispose(): void {
    this.off();
    this.reset();
  }

  /** The saved connection's identity: its generation while there is one, else ''. */
  private connection(): string {
    const b = this.host.book;
    return b.connected ? String(b.state?.generation ?? 0) : '';
  }

  /** An answer is of the shown connection (one without a generation is taken as it). */
  private ofConnection(data: unknown): boolean {
    const g = (data as { generation?: unknown } | null)?.generation;
    return typeof g !== 'number' || String(g) === this.conn;
  }

  /** Forgets the lists and every request on its way (the connection they were of is gone). */
  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wsSeq.cancel();
    this.projSeq.cancel();
    this.workspaces = { s: 'idle' };
    this.projects = { s: 'idle' };
  }

  private pickWorkspace(id: string): void {
    if (id === this.ws) return;
    this.ws = id;
    this.project = ''; // a project of another workspace is never kept
    this.projects = id ? { s: 'loading' } : { s: 'idle' };
    this.projSeq.cancel();
    this.render();
    this.changed();
    if (id) this.loadProjects(this.host.debounceMs ?? 200);
  }

  private loadWorkspaces(): void {
    const ticket = this.wsSeq.next();
    this.workspaces = { s: 'loading' };
    this.render();
    void this.host.send('kaneo.workspaces', {}).then((r) => {
      if (!this.wsSeq.current(ticket)) return;
      if (!r.ok) {
        this.workspaces = { s: 'error', code: r.code, message: r.message };
        return this.render();
      }
      if (!this.ofConnection(r.data)) return; // another connection's: the kaneo.update that says so asks again
      const d = r.data as { workspaces?: unknown };
      const items = Array.isArray(d?.workspaces) ? d.workspaces.filter((w): w is KaneoWorkspace => typeof w?.id === 'string' && typeof w?.name === 'string') : [];
      this.workspaces = { s: 'ready', items };
      this.render();
      if (this.ws && items.some((w) => w.id === this.ws)) this.loadProjects(0);
    });
  }

  private loadProjects(delay: number): void {
    const ws = this.ws;
    const ticket = this.projSeq.next();
    this.projects = { s: 'loading' };
    this.render();
    if (this.timer) clearTimeout(this.timer);
    const go = () => {
      this.timer = null;
      if (!this.projSeq.current(ticket)) return;
      void this.host.send('kaneo.projects', { workspace_id: ws }).then((r) => {
        // A later workspace (or a reset) took over: this answer is about another choice.
        if (!this.projSeq.current(ticket) || ws !== this.ws) return;
        if (!r.ok) {
          this.projects = { s: 'error', code: r.code, message: r.message };
          return this.render();
        }
        if (!this.ofConnection(r.data)) return;
        const d = r.data as { projects?: unknown };
        const items = Array.isArray(d?.projects) ? d.projects.filter((p): p is KaneoProject => typeof p?.id === 'string' && typeof p?.name === 'string') : [];
        this.projects = { s: 'ready', items };
        this.render();
      });
    };
    if (delay > 0) this.timer = setTimeout(go, delay);
    else go();
  }

  private render(): void {
    const book = this.host.book;
    const connected = book.connected;
    this.notConnected.textContent = connected ? '' : book.known ? 'Kaneo is not connected. Connect it in Settings → Kaneo, then pick a workspace and project here.' : 'This bridge has no Kaneo support. Update it to use Kaneo.';
    this.notConnected.classList.toggle('field-error', !connected && this.active);

    // Workspaces.
    const wsOpts: HTMLOptionElement[] = [];
    const w = this.workspaces;
    const savedWsName = this.saved?.workspace_id === this.ws ? this.saved.workspace_name : book.state?.default_workspace?.id === this.ws ? book.state.default_workspace.name : undefined;
    let wsHint = '';
    let wsError = false;
    if (w.s === 'ready') {
      wsOpts.push(h('option', { value: '' }, 'Choose a workspace'));
      for (const x of w.items) wsOpts.push(h('option', { value: x.id }, x.name));
      if (this.ws && !w.items.some((x) => x.id === this.ws)) {
        wsOpts.push(h('option', { value: this.ws }, `${savedWsName ?? 'Saved workspace'} (no access)`));
        wsHint = 'This key does not reach the saved workspace any more. Pick another, or ask for access in Kaneo.';
        wsError = true;
      } else if (!w.items.length) {
        wsHint = 'This key reaches no workspace yet: no project can be linked.';
        wsError = true;
      } else if (book.state?.default_workspace?.id === this.ws && this.saved?.workspace_id !== this.ws) wsHint = 'The bridge’s default workspace. Pick another for this floor if you like.';
    } else {
      wsOpts.push(h('option', { value: this.ws }, w.s === 'loading' ? 'Loading workspaces…' : (savedWsName ?? (this.ws ? 'Saved workspace' : '—'))));
      if (w.s === 'error') {
        wsHint = kaneoFailureText(w.code, w.message);
        wsError = true;
      }
    }
    this.workspaceSelect.replaceChildren(...wsOpts);
    this.workspaceSelect.value = this.ws;
    this.workspaceSelect.disabled = !connected || w.s !== 'ready';
    this.setHint(this.workspaceHint, wsHint, wsError);

    // Projects.
    const p = this.projects;
    const pOpts: HTMLOptionElement[] = [];
    const savedProjName = this.saved?.workspace_id === this.ws && this.saved.project_id === this.project ? this.saved.project_name : undefined;
    let pHint = '';
    let pError = false;
    if (p.s === 'ready') {
      pOpts.push(h('option', { value: '' }, p.items.length ? 'Choose a project' : 'No projects'));
      for (const x of p.items) pOpts.push(h('option', { value: x.id }, x.name));
      if (this.project && !p.items.some((x) => x.id === this.project)) {
        pHint = `${savedProjName ?? 'The saved project'} is gone or archived. Choose another.`;
        pError = true;
        this.project = '';
        queueMicrotask(this.changed);
      } else if (!p.items.length) pHint = 'This workspace has no projects you can link. Make one in Kaneo, or pick another workspace.';
    } else {
      pOpts.push(h('option', { value: this.project }, p.s === 'loading' ? 'Loading projects…' : (savedProjName ?? (this.ws ? '—' : 'Choose a workspace first'))));
      if (p.s === 'error') {
        pHint = p.code === 'forbidden' ? 'This key may not see that workspace’s projects. Ask for access in Kaneo, or pick another workspace.' : kaneoFailureText(p.code, p.message);
        pError = true;
      }
    }
    this.projectSelect.replaceChildren(...pOpts);
    this.projectSelect.value = this.project;
    this.projectSelect.disabled = !connected || p.s !== 'ready' || !p.items.length;
    this.setHint(this.projectHint, pHint, pError);
    this.projectSelect.setAttribute('aria-busy', p.s === 'loading' ? 'true' : 'false');
    this.retry.hidden = !(w.s === 'error' || p.s === 'error');
  }

  private setHint(el: HTMLElement, text: string, error: boolean): void {
    el.textContent = text;
    el.classList.toggle('field-error', error);
  }

  /** The floor form flags a field (its error replaces the hint until the next render). */
  flag(key: 'kaneoWorkspace' | 'kaneoProject', message: string | null): void {
    const el = key === 'kaneoWorkspace' ? this.workspaceHint : this.projectHint;
    const sel = key === 'kaneoWorkspace' ? this.workspaceSelect : this.projectSelect;
    if (message) this.setHint(el, message, true);
    sel.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
}

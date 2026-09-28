import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName } from '../net/protocol';
import { buildingOrder, floorMove } from '../world/arrange';
import { DEFAULT_STATUS_FIELD, effortsFor, formFrom, parseForm, settingsPatch, type FieldKey, type SettingsForm } from '../world/settings';
import type { FloorView, WorldStore } from '../world/store';
import { h, icon, ICON, replaceKeepingFocus, type Child } from './dom';
import { failureText } from './messages';

/**
 * The M3 panels over the HUD: the elevator (a building's floors, travel,
 * wake / sleep), the buildings directory (create, rename, delete, arrange)
 * and floor settings, plus a confirmation sheet for destructive actions.
 * One modal <dialog> at a time (the confirmation stacks on top of it);
 * live world changes re-render the open list in place, keeping focus.
 */

export interface PanelHost {
  readonly store: WorldStore;
  /** The floor the player is on, null in the city. */
  here(): string | null;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The bridge answered `unknown_command` for it before. */
  unsupported(t: CommandName): boolean;
  /** Close the panels and ride the elevator to a floor. */
  travel(session: string): void;
  /** HUD toast, for results that arrive after the panel closed. */
  toast(msg: string, kind: 'info' | 'error'): void;
}

type View = { kind: 'elevator'; building: string | null } | { kind: 'buildings' } | { kind: 'settings'; session: string; from: View | null };

export interface ElevatorRow {
  session: string;
  /** From the ground, null in the lot. */
  number: number | null;
  state: 'running' | 'asleep';
  transition: 'waking' | 'sleeping' | null;
  counts: { working: number; needsYou: number; idle: number; total: number };
  current: boolean;
  /** Wake / sleep button on this row. */
  action: 'wake' | 'sleep' | null;
  resume: FloorView['resume'];
}

/** What the open panel shows (test hook `window.__h3d.panel()`). */
export type PanelSummary = (
  | { kind: 'elevator'; building: string | null; title: string; rows: ElevatorRow[] }
  | { kind: 'buildings'; buildings: Array<{ id: string; name: string; floors: string[] }>; lot: string[] }
  | { kind: 'settings'; session: string; form: SettingsForm; repoSuggested: boolean; statusDefault: boolean }
) & { status: string; confirm: { title: string; body: string } | null };

const LOT = 'Unassigned lot';

function stateOf(v: FloorView): ElevatorRow['state'] {
  return v.asleep ? 'asleep' : 'running';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function countsText(v: FloorView): string {
  if (v.asleep) return `asleep, ${plural(v.counts.total, 'worker')}`;
  return `${v.counts.working} working, ${v.counts.needsYou} need you, ${v.counts.idle} idle`;
}

function countChips(v: FloorView): HTMLElement {
  const c = v.counts;
  const item = (cls: string, n: number, label: string) => h('span', { class: `count count--${cls}` }, h('i'), h('b', {}, String(n)), h('span', {}, label));
  return h('span', { class: 'lift-counts', 'aria-hidden': 'true' }, item('working', c.working, 'working'), item('needs_you', c.needsYou, 'need you'), item('idle', c.idle, 'idle'));
}

const TRANSITION_TAPE: Record<'waking' | 'sleeping', string> = { waking: 'Waking up', sleeping: 'Going to sleep' };
const RESUME_WORD = { pending: 'waiting', confirmed: 'resumed', fallback: 'relaunched', failed: 'did not resume' } as const;

export class Panels {
  private readonly dialog = h('dialog', { class: 'panel', 'aria-labelledby': 'panel-title', 'aria-describedby': 'panel-sub' });
  private readonly head = h('header', { class: 'panel-head' });
  private readonly body = h('div', { class: 'panel-body' });
  private readonly statusEl = h('p', { class: 'panel-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'panel-status panel-status--error', role: 'alert' });
  private readonly confirmEl = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-body' });
  private view: View | null = null;
  private renderKey = '';
  /** Commands in flight, by what they are about (`wake:<session>`, `b:<id>`, `f:<session>`). */
  private readonly busy = new Map<string, string>();
  private renaming: { id: string; value: string; error: string } | null = null;
  private moving: string | null = null;
  private list: HTMLElement | null = null;
  private settingsForm: { el: HTMLFormElement; read(): SettingsForm; session: string; repoSuggested: boolean; statusDefault: boolean } | null = null;
  private confirmState: { title: string; body: () => string; resolve(ok: boolean): void } | null = null;
  private statusText = '';

  constructor(
    parent: HTMLElement,
    private readonly host: PanelHost,
  ) {
    this.dialog.append(this.head, this.body, this.statusEl, this.alertEl);
    this.alertEl.hidden = true;
    this.dialog.addEventListener('close', () => {
      // `close` is queued: the panel may have been opened again since.
      if (this.dialog.open) return;
      this.view = null;
      this.renaming = null;
      this.moving = null;
      this.settingsForm = null;
      this.list = null;
    });
    // A click on the backdrop closes the panel (like the sheet).
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
    // Esc: `cancel` fires at once (the queued `close` could reach a newer confirmation).
    this.confirmEl.addEventListener('cancel', () => this.endConfirm(false));
    parent.append(this.dialog, this.confirmEl);
  }

  get open(): boolean {
    return this.dialog.open || this.confirmEl.open;
  }

  close(): void {
    this.endConfirm(false);
    if (this.dialog.open) this.dialog.close();
  }

  openElevator(building: string | null): void {
    this.show({ kind: 'elevator', building });
  }

  openBuildings(): void {
    this.show({ kind: 'buildings' });
  }

  openSettings(session: string): void {
    this.show({ kind: 'settings', session, from: this.view && this.view.kind !== 'settings' ? this.view : null });
  }

  /** Building (id, or null for the lot) a floor belongs to, as the city shows it. */
  buildingOf(session: string): string | null {
    const b = this.host.store.floors.get(session)?.building ?? null;
    return b !== null && this.host.store.buildings.has(b) ? b : null;
  }

  private show(v: View): void {
    this.view = v;
    this.renaming = null;
    this.moving = null;
    this.settingsForm = null;
    this.renderKey = '';
    this.setStatus('');
    this.render(true);
    if (!this.dialog.open) this.dialog.showModal();
    this.focusInitial();
  }

  private focusInitial(): void {
    const v = this.view;
    if (!v) return;
    let el: HTMLElement | null = null;
    if (v.kind === 'elevator') el = this.body.querySelector<HTMLElement>('.lift-go[aria-current="location"]') ?? this.body.querySelector<HTMLElement>('.lift-go');
    else if (v.kind === 'buildings') el = this.body.querySelector<HTMLElement>('#dir-new-name');
    else el = this.body.querySelector<HTMLElement>('#set-repo');
    (el ?? this.head.querySelector<HTMLElement>('.panel-close'))?.focus();
  }

  /** The world changed: redraw what the open panel lists. */
  refresh(): void {
    if (!this.dialog.open || !this.view) return;
    this.render(false);
    if (this.confirmState) this.renderConfirmBody();
  }

  private setStatus(msg: string, kind: 'info' | 'error' = 'info'): void {
    this.statusText = msg;
    const err = kind === 'error';
    this.alertEl.hidden = !err || !msg;
    this.statusEl.hidden = err || !msg;
    (err ? this.alertEl : this.statusEl).textContent = msg;
    (err ? this.statusEl : this.alertEl).textContent = '';
  }

  /** In the panel while it is open, else as a HUD toast. */
  private notify(msg: string, kind: 'info' | 'error' = 'info'): void {
    if (this.dialog.open) this.setStatus(msg, kind);
    else this.host.toast(msg, kind);
  }

  private headFor(title: string, sub: string, lead: Child, back: View | null): Node[] {
    const close = h('button', { class: 'btn btn--icon panel-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close));
    const nodes: Node[] = [];
    if (back) {
      nodes.push(
        h(
          'button',
          {
            class: 'btn btn--icon panel-back',
            'data-key': 'back',
            'aria-label': back.kind === 'elevator' ? 'Back to the elevator' : 'Back',
            title: 'Back',
            onclick: () => this.show(back),
          },
          icon(ICON.back),
        ),
      );
    }
    if (lead) nodes.push(lead as Node);
    nodes.push(h('div', { class: 'panel-titles' }, h('h2', { id: 'panel-title' }, title), h('p', { id: 'panel-sub' }, sub)), close);
    return nodes;
  }

  private render(first: boolean): void {
    const v = this.view;
    if (!v) return;
    if (v.kind === 'elevator') this.renderElevator(v.building);
    else if (v.kind === 'buildings') this.renderBuildings();
    else this.renderSettings(v, first);
  }

  // ---- elevator ----------------------------------------------------------------

  rows(building: string | null): ElevatorRow[] {
    const here = this.host.here();
    return this.host.store.stack(building).map((f) => ({
      session: f.session,
      number: f.level?.number ?? null,
      state: stateOf(f),
      transition: f.transition,
      counts: { working: f.counts.working, needsYou: f.counts.needsYou, idle: f.counts.idle, total: f.counts.total },
      current: f.session === here,
      action: f.transition ? null : f.asleep ? 'wake' : 'sleep',
      resume: f.resume,
    }));
  }

  private elevatorTitle(building: string | null): string {
    return building === null ? LOT : (this.host.store.buildings.get(building)?.name ?? 'Building');
  }

  private renderElevator(building: string | null): void {
    const store = this.host.store;
    if (building !== null && !store.buildings.has(building)) {
      this.close();
      this.host.toast('That building was deleted.', 'info');
      return;
    }
    const floors = store.stack(building);
    const here = this.host.here();
    const hereView = here ? floors.find((f) => f.session === here) : undefined;
    const key = JSON.stringify([
      building,
      this.elevatorTitle(building),
      here,
      [...this.busy],
      floors.map((f) => [f.session, f.level?.number, f.asleep, f.transition, f.counts, f.workers.map((w) => [w.name, w.worker.resume ?? ''])]),
      this.host.unsupported('floor.wake'),
      this.host.unsupported('floor.sleep'),
    ]);
    if (key === this.renderKey) return;
    this.renderKey = key;

    const display = h(
      'div',
      { class: 'lift-display', 'aria-hidden': 'true', title: hereView ? 'The floor you are on' : 'You are in the lobby' },
      icon(ICON.lift),
      h('b', {}, hereView ? (hereView.level ? String(hereView.level.number) : 'P') : 'L'),
    );
    const sub =
      floors.length === 0
        ? 'No floors here yet'
        : `${plural(floors.length, 'floor')} · ${hereView ? `you are on ${hereView.level ? `floor ${hereView.level.number}` : hereView.session}` : building === null ? 'sessions in no building' : 'top floor first'}`;
    replaceKeepingFocus(this.head, this.headFor(this.elevatorTitle(building), sub, display, null));

    if (!floors.length) {
      replaceKeepingFocus(this.body, [h('p', { class: 'panel-empty' }, building === null ? 'Every floor is in a building.' : 'Move floors here from the Buildings panel.')]);
      return;
    }
    const list = h('ol', { class: 'lift-floors', 'aria-label': 'Floors, top to bottom' });
    for (const f of floors) list.append(this.elevatorRow(f, f.session === here));
    replaceKeepingFocus(this.body, [list]);
  }

  private elevatorRow(f: FloorView, current: boolean): HTMLElement {
    const num = f.level ? String(f.level.number) : '';
    const state = f.transition ? TRANSITION_TAPE[f.transition].toLowerCase() : countsText(f);
    const label = `${num ? `Floor ${num}, ` : ''}${f.session}: ${state}. ${current ? 'You are here.' : 'Go there.'}`;
    const meta: Child = f.transition
      ? h('span', { class: `tape tape--${f.transition}` }, TRANSITION_TAPE[f.transition])
      : f.asleep
        ? h('span', { class: 'lift-asleep' }, h('span', { class: 'tape tape--asleep' }, 'Asleep'), h('span', {}, plural(f.counts.total, 'worker')))
        : countChips(f);
    const go = h(
      'button',
      {
        class: 'lift-go',
        'data-key': `go:${f.session}`,
        'aria-label': label,
        'aria-current': current ? 'location' : null,
        title: f.floor.error ? `This floor cannot be read: ${f.floor.error}` : null,
        onclick: () => this.goTo(f.session),
        onkeydown: (e: Event) => this.rowKeys(e as KeyboardEvent),
      },
      h('span', { class: 'lift-num', 'data-empty': num ? null : 'true' }, num),
      h(
        'span',
        { class: 'lift-name' },
        h('span', { class: 'lift-title' }, h('span', { class: 'lift-session' }, f.session), current ? h('span', { class: 'lift-here' }, 'You are here') : null),
        meta,
      ),
    );
    const actions = h('div', { class: 'lift-actions' });
    const busy = this.busy.get(`floor:${f.session}`);
    const wakeSleep = f.transition ? null : f.asleep ? 'wake' : 'sleep';
    const t: CommandName = wakeSleep === 'wake' ? 'floor.wake' : 'floor.sleep';
    if (busy || f.transition) {
      actions.append(h('button', { class: 'btn btn--sm', 'aria-disabled': 'true', 'data-key': `ws:${f.session}` }, busy ?? (f.transition === 'waking' ? 'Waking…' : 'Going to sleep…')));
    } else if (wakeSleep) {
      const no = this.host.unsupported(t);
      actions.append(
        h(
          'button',
          {
            class: `btn btn--sm${wakeSleep === 'wake' ? ' btn--wake' : ''}`,
            'data-key': `ws:${f.session}`,
            'aria-disabled': no ? 'true' : null,
            title: no ? failureText(t, 'unknown_command', '') : wakeSleep === 'wake' ? `Start ${f.session}'s herdr server and resume its agents` : `Stop ${f.session}'s herdr session; its agents resume on the next wake`,
            'aria-label': `${wakeSleep === 'wake' ? 'Wake' : 'Sleep'} floor ${f.session}`,
            onclick: () => (no ? this.notify(failureText(t, 'unknown_command', ''), 'error') : wakeSleep === 'wake' ? void this.wake(f.session) : void this.sleep(f.session)),
          },
          icon(wakeSleep === 'wake' ? ICON.sun : ICON.moon),
          h('span', {}, wakeSleep === 'wake' ? 'Wake floor' : 'Sleep floor'),
        ),
      );
    }
    actions.append(
      h(
        'button',
        { class: 'btn btn--sm', 'data-key': `set:${f.session}`, 'aria-label': `Settings for ${f.session}`, onclick: () => this.openSettings(f.session) },
        icon(ICON.gear),
        h('span', {}, 'Settings'),
      ),
    );
    const li = h('li', { class: 'lift-row', 'data-session': f.session, 'data-state': stateOf(f), 'data-transition': f.transition }, go, actions);
    const progress = this.progress(f);
    if (progress) li.append(progress);
    return li;
  }

  /** Wake / sleep progress under a row: what is happening, and each worker's resume. */
  private progress(f: FloorView): HTMLElement | null {
    const r = f.resume;
    if (!f.transition && !r) return null;
    const box = h('div', { class: 'lift-progress', 'data-key': `progress:${f.session}` });
    let line: string;
    if (f.transition === 'sleeping') line = 'Saving the agents’ sessions and stopping herdr…';
    else if (f.transition === 'waking' && f.asleep) line = 'Starting the herdr server…';
    else if (r) {
      const back = r.confirmed + r.fallback;
      line = f.transition === 'waking' ? `Resuming agents: ${back} of ${r.total} back` : `Woke up: ${back} of ${r.total} agents back${r.failed ? `, ${r.failed} did not resume` : ''}`;
    } else line = 'Waking up…';
    box.append(h('p', {}, line));
    if (r && r.total) {
      const done = r.confirmed + r.fallback + r.failed;
      box.append(
        h(
          'div',
          { class: 'lift-bar', role: 'progressbar', 'aria-label': `Agents resumed on ${f.session}`, 'aria-valuemin': 0, 'aria-valuemax': r.total, 'aria-valuenow': done },
          h('i', { style: `transform:scaleX(${(done / r.total).toFixed(3)})` }),
        ),
      );
      // During the wake, every agent; afterwards only the ones that need a look.
      const show = f.workers.filter((w) => w.worker.resume && (f.transition || w.worker.resume === 'failed' || w.worker.resume === 'fallback'));
      if (show.length) {
        const ul = h('ul', { class: 'lift-resume', 'aria-label': 'Agents' });
        for (const w of show) {
          const s = w.worker.resume ?? 'pending';
          ul.append(h('li', { class: `resume resume--${s}` }, h('i', { 'aria-hidden': 'true' }), h('span', {}, w.name), h('span', { class: 'resume-word' }, RESUME_WORD[s])));
        }
        box.append(ul);
      }
    }
    return box;
  }

  /** Up / down between floor buttons, like the elevator's panel. */
  private rowKeys(e: KeyboardEvent): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const all = [...this.body.querySelectorAll<HTMLElement>('.lift-go')];
    const i = all.indexOf(e.target as HTMLElement);
    const next = all[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  private goTo(session: string): void {
    if (session === this.host.here()) {
      this.close();
      return;
    }
    this.host.travel(session);
  }

  private async wake(session: string): Promise<void> {
    const k = `floor:${session}`;
    if (this.busy.has(k)) return;
    this.busy.set(k, 'Waking…');
    this.setStatus(`Waking ${session}…`);
    this.refresh();
    const r = await this.host.send('floor.wake', { session });
    this.busy.delete(k);
    if (r.ok) {
      const ws = (r.data as { workers?: Array<{ resume?: string }> } | undefined)?.workers ?? [];
      const n = (s: string) => ws.filter((w) => w.resume === s).length;
      const parts = [n('confirmed') && `${n('confirmed')} resumed`, n('fallback') && `${n('fallback')} relaunched`, n('failed') && `${n('failed')} did not resume`].filter(Boolean);
      this.notify(`${session} is awake${parts.length ? `: ${parts.join(', ')}` : ''}.`, n('failed') ? 'error' : 'info');
    } else this.notify(failureText('floor.wake', r.code, r.message, { floor: session }), 'error');
    this.refresh();
  }

  private async sleep(session: string): Promise<void> {
    const k = `floor:${session}`;
    if (this.busy.has(k)) return;
    const counts = () => this.host.store.floorView(session)?.counts;
    const ok = await this.confirm({
      title: `Put ${session} to sleep?`,
      body: () => {
        const c = counts();
        const now =
          !c || (!c.working && !c.needsYou)
            ? 'No agent is working or waiting on you right now.'
            : `${plural(c.working, 'agent is', 'agents are')} working and ${plural(c.needsYou, 'needs', 'need')} you right now.`;
        return `${now} herdr saves and stops the session; the agents pick their conversations back up when you wake the floor.`;
      },
      ok: 'Sleep floor',
      cancel: 'Keep running',
    });
    if (!ok) return;
    this.busy.set(k, 'Going to sleep…');
    this.setStatus(`Putting ${session} to sleep…`);
    this.refresh();
    const r = await this.host.send('floor.sleep', { session });
    this.busy.delete(k);
    if (r.ok) this.notify(`${session} is asleep. Its agents resume when you wake it.`);
    else this.notify(failureText('floor.sleep', r.code, r.message, { floor: session }), 'error');
    this.refresh();
  }

  // ---- buildings ---------------------------------------------------------------

  private renderBuildings(): void {
    const store = this.host.store;
    const bs = store.sortedBuildings();
    const lot = store.stack(null);
    const key = JSON.stringify([
      bs.map((b) => [b.id, b.name, store.stack(b.id).map((f) => [f.session, f.floor.index, f.asleep])]),
      lot.map((f) => [f.session, f.asleep]),
      [...this.busy],
      this.renaming && { id: this.renaming.id, error: this.renaming.error },
      this.moving,
    ]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    const floors = bs.reduce((n, b) => n + store.stack(b.id).length, 0) + lot.length;
    replaceKeepingFocus(
      this.head,
      this.headFor('Buildings', `${plural(bs.length, 'building')} · ${plural(floors, 'floor')} · changes save at once`, h('div', { class: 'lift-display', 'aria-hidden': 'true' }, icon(ICON.building)), null),
    );
    if (!this.list || !this.body.contains(this.list)) {
      this.list = h('div', { class: 'dir' });
      this.body.replaceChildren(this.newBuildingForm(), this.list);
    }
    const blocks: Node[] = bs.map((b, i) => this.buildingBlock(b.id, b.name, i, bs.length));
    blocks.push(this.lotBlock(lot));
    replaceKeepingFocus(this.list, blocks, 'new');
    const r = this.renaming;
    if (r) {
      const input = this.list.querySelector<HTMLInputElement>('#dir-rename');
      if (input && document.activeElement !== input && !this.confirmEl.open) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  private nameError(name: string, except = ''): string {
    const n = name.trim();
    if (!n) return 'Give the building a name.';
    if (new TextEncoder().encode(n).length > 64) return 'Keep the name within 64 bytes.';
    for (const b of this.host.store.buildings.values()) {
      if (b.id !== except && b.name.toLowerCase() === n.toLowerCase()) return `Another building is already called “${b.name}”.`;
    }
    return '';
  }

  private newBuildingForm(): HTMLElement {
    const input = h('input', {
      id: 'dir-new-name',
      'data-key': 'new',
      name: 'name',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 64,
      placeholder: 'e.g. Work, Personal',
      'aria-describedby': 'dir-new-hint',
    });
    const hint = h('p', { id: 'dir-new-hint', class: 'field-hint' }, 'Buildings stand left to right in the city in this order.');
    const add = h('button', { class: 'btn btn--primary', type: 'submit' }, icon(ICON.plus), h('span', {}, 'Add building'));
    const form = h('form', { class: 'dir-new', novalidate: true }, h('label', { for: 'dir-new-name' }, 'New building'), h('div', { class: 'field-row' }, input, add), hint);
    const setError = (msg: string) => {
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      hint.textContent = msg || 'Buildings stand left to right in the city in this order.';
      hint.classList.toggle('field-error', !!msg);
    };
    input.addEventListener('input', () => input.getAttribute('aria-invalid') === 'true' && setError(''));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (add.getAttribute('aria-disabled') === 'true') return;
      const name = input.value.trim();
      const err = this.nameError(name);
      setError(err);
      if (err) {
        input.focus();
        return;
      }
      add.setAttribute('aria-disabled', 'true');
      void this.host.send('building.create', { name }).then((r) => {
        add.removeAttribute('aria-disabled');
        if (r.ok) {
          input.value = '';
          this.notify(`Added ${name}. Move floors into it below.`);
        } else this.notify(failureText('building.create', r.code, r.message, { name }), 'error');
        this.refresh();
      });
    });
    return form;
  }

  private tool(label: string, paths: string, key: string, fn: () => void, disabled = false, extra = ''): HTMLButtonElement {
    return h(
      'button',
      {
        class: `btn btn--icon btn--sm${extra}`,
        'aria-label': label,
        title: label,
        'data-key': key,
        'aria-disabled': disabled ? 'true' : null,
        onclick: () => {
          if (!disabled) fn();
        },
      },
      icon(paths),
    );
  }

  private buildingBlock(id: string, name: string, i: number, n: number): HTMLElement {
    const store = this.host.store;
    const floors = store.stack(id);
    const busy = this.busy.has(`b:${id}`);
    const head = h('div', { class: 'dir-bhead' });
    if (this.renaming?.id === id) {
      const r = this.renaming;
      const input = h('input', {
        id: 'dir-rename',
        'data-key': `rename-input:${id}`,
        value: r.value,
        maxlength: 64,
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': `New name for ${name}`,
        'aria-invalid': r.error ? 'true' : 'false',
        'aria-describedby': r.error ? 'dir-rename-error' : null,
        oninput: (e: Event) => {
          if (this.renaming) this.renaming.value = (e.target as HTMLInputElement).value;
        },
        onkeydown: (e: Event) => {
          const k = e as KeyboardEvent;
          if (k.key !== 'Escape') return;
          // Esc cancels the rename, not the whole panel.
          k.preventDefault();
          k.stopPropagation();
          this.cancelRename(id);
        },
      });
      const form = h(
        'form',
        { class: 'dir-rename', novalidate: true },
        input,
        h('button', { class: 'btn btn--sm btn--primary', type: 'submit' }, 'Save'),
        h('button', { class: 'btn btn--sm', onclick: () => this.cancelRename(id) }, 'Cancel'),
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.rename(id);
      });
      head.append(form);
      if (r.error) head.append(h('p', { id: 'dir-rename-error', class: 'field-hint field-error' }, r.error));
    } else {
      head.append(
        h('h3', { class: 'dir-bname' }, name),
        h('span', { class: 'dir-bcount' }, plural(floors.length, 'floor')),
        h(
          'div',
          { class: 'dir-tools' },
          this.tool(`Move ${name} up (further left in the city)`, ICON.up, `bup:${id}`, () => void this.moveBuilding(id, -1), busy || i === 0),
          this.tool(`Move ${name} down (further right in the city)`, ICON.down, `bdown:${id}`, () => void this.moveBuilding(id, 1), busy || i === n - 1),
          this.tool(`Rename ${name}`, ICON.pencil, `rename:${id}`, () => this.startRename(id, name), busy),
          this.tool(`Delete ${name}`, ICON.trash, `delete:${id}`, () => void this.deleteBuilding(id), busy, ' btn--danger-quiet'),
        ),
      );
    }
    const list = h('ol', { class: 'dir-floors', 'aria-label': `Floors of ${name}, top to bottom` });
    floors.forEach((f, j) => list.append(this.floorItem(f, id, j, floors.length)));
    if (!floors.length) list.append(h('li', { class: 'dir-empty' }, 'No floors yet. Use Move on a floor below to bring one here.'));
    return h('section', { class: 'dir-building', 'data-id': id, 'aria-label': name }, head, list);
  }

  private lotBlock(lot: FloorView[]): HTMLElement {
    const list = h('ol', { class: 'dir-floors', 'aria-label': 'Floors in the unassigned lot' });
    lot.forEach((f, j) => list.append(this.floorItem(f, null, j, lot.length)));
    if (!lot.length) list.append(h('li', { class: 'dir-empty' }, 'Every floor is in a building.'));
    return h(
      'section',
      { class: 'dir-building dir-building--lot', 'aria-label': LOT },
      h('div', { class: 'dir-bhead' }, h('h3', { class: 'dir-bname' }, LOT), h('span', { class: 'dir-bcount' }, `${plural(lot.length, 'floor')} · sessions in no building`)),
      list,
    );
  }

  private floorItem(f: FloorView, building: string | null, j: number, n: number): HTMLElement {
    const s = f.session;
    const busy = this.busy.has(`f:${s}`);
    const tools = h('div', { class: 'dir-tools' });
    if (building !== null) {
      tools.append(
        this.tool(`Move ${s} up a floor`, ICON.up, `fup:${s}`, () => void this.moveFloor(s, building, -1), busy || j === 0),
        this.tool(`Move ${s} down a floor`, ICON.down, `fdown:${s}`, () => void this.moveFloor(s, building, 1), busy || j === n - 1),
      );
    }
    tools.append(
      h(
        'button',
        {
          class: 'btn btn--sm',
          'data-key': `move:${s}`,
          'aria-expanded': this.moving === s ? 'true' : 'false',
          'aria-label': `Move ${s} to another building`,
          'aria-disabled': busy ? 'true' : null,
          onclick: () => {
            if (busy) return;
            this.moving = this.moving === s ? null : s;
            this.refresh();
            this.list?.querySelector<HTMLElement>(this.moving ? `[data-key^="to:${CSS.escape(s)}:"]` : `[data-key="move:${CSS.escape(s)}"]`)?.focus();
          },
        },
        icon(ICON.move),
        h('span', {}, 'Move'),
      ),
    );
    const li = h(
      'li',
      { class: 'dir-floor', 'data-session': s },
      h('span', { class: 'lift-num lift-num--sm', 'data-empty': f.level ? null : 'true', 'aria-hidden': 'true' }, f.level ? String(f.level.number) : ''),
      h('span', { class: 'dir-fname' }, h('span', { class: 'visually-hidden' }, f.level ? `Floor ${f.level.number}: ` : ''), s),
      f.asleep ? h('span', { class: 'tape tape--asleep' }, 'Asleep') : h('span', { class: 'dir-fstate' }, plural(f.counts.total, 'worker')),
      tools,
    );
    if (this.moving === s) {
      const menu = h('div', { class: 'dir-move', role: 'group', 'aria-label': `Move ${s} to` }, h('span', { class: 'dir-move-label' }, 'Move to'));
      for (const b of this.host.store.sortedBuildings()) {
        if (b.id === building) continue;
        menu.append(h('button', { class: 'btn btn--sm', 'data-key': `to:${s}:${b.id}`, onclick: () => void this.assign(s, b.id, b.name) }, b.name));
      }
      if (building !== null) menu.append(h('button', { class: 'btn btn--sm', 'data-key': `to:${s}:lot`, onclick: () => void this.assign(s, null, LOT) }, LOT));
      menu.append(
        h(
          'button',
          {
            class: 'btn btn--sm btn--quiet',
            'data-key': `to:${s}:cancel`,
            onclick: () => {
              this.moving = null;
              this.refresh();
              this.list?.querySelector<HTMLElement>(`[data-key="move:${CSS.escape(s)}"]`)?.focus();
            },
          },
          'Cancel',
        ),
      );
      if (menu.children.length === 2) menu.insertBefore(h('span', { class: 'dir-move-label' }, 'No other building yet: add one above.'), menu.lastChild);
      li.append(menu);
    }
    return li;
  }

  /** Runs a command for `key` (disabling its controls meanwhile) and reports a failure. */
  private async run<T extends CommandName>(key: string, t: T, args: CommandArgs[T], ctx: { floor?: string; name?: string } = {}): Promise<boolean> {
    if (this.busy.has(key)) return false;
    this.busy.set(key, '…');
    this.refresh();
    const r = await this.host.send(t, args);
    this.busy.delete(key);
    if (!r.ok) this.notify(failureText(t, r.code, r.message, ctx), 'error');
    this.refresh();
    return r.ok;
  }

  private async moveBuilding(id: string, dir: -1 | 1): Promise<void> {
    const ids = buildingOrder(
      this.host.store.sortedBuildings().map((b) => b.id),
      id,
      dir,
    );
    if (!ids) return;
    const name = this.host.store.buildings.get(id)?.name ?? '';
    if (await this.run(`b:${id}`, 'building.reorder', { ids }, { name })) this.setStatus(`Moved ${name} ${dir < 0 ? 'up' : 'down'}.`);
  }

  private async moveFloor(session: string, building: string, dir: -1 | 1): Promise<void> {
    const args = floorMove(this.host.store.stack(building), session, building, dir);
    if (!args) return;
    if (await this.run(`f:${session}`, 'floor.assign', args, { floor: session })) {
      this.setStatus(`Moved ${session} ${dir < 0 ? 'up' : 'down'} a floor.`);
    }
  }

  private async assign(session: string, building: string | null, name: string): Promise<void> {
    this.moving = null;
    // A new floor goes on top of its building.
    const args: CommandArgs['floor.assign'] = building === null ? { session, building: null } : { session, building, index: 0 };
    if (await this.run(`f:${session}`, 'floor.assign', args, { floor: session })) {
      this.setStatus(building === null ? `Moved ${session} to the unassigned lot.` : `Moved ${session} to the top of ${name}.`);
    }
    this.list?.querySelector<HTMLElement>(`[data-key="move:${CSS.escape(session)}"]`)?.focus();
  }

  private startRename(id: string, name: string): void {
    this.renaming = { id, value: name, error: '' };
    this.refresh();
    const input = this.list?.querySelector<HTMLInputElement>('#dir-rename');
    input?.focus();
    input?.select();
  }

  private cancelRename(id: string): void {
    this.renaming = null;
    this.refresh();
    this.list?.querySelector<HTMLElement>(`[data-key="rename:${CSS.escape(id)}"]`)?.focus();
  }

  private async rename(id: string): Promise<void> {
    const r = this.renaming;
    if (!r || r.id !== id) return;
    const name = r.value.trim();
    const old = this.host.store.buildings.get(id)?.name ?? '';
    if (name === old) {
      this.cancelRename(id);
      return;
    }
    r.error = this.nameError(name, id);
    if (r.error) {
      this.refresh();
      return;
    }
    if (await this.run(`b:${id}`, 'building.rename', { id, name }, { name })) {
      this.renaming = null;
      this.setStatus(`Renamed ${old} to ${name}.`);
      this.refresh();
      this.list?.querySelector<HTMLElement>(`[data-key="rename:${CSS.escape(id)}"]`)?.focus();
    }
  }

  private async deleteBuilding(id: string): Promise<void> {
    const store = this.host.store;
    const name = store.buildings.get(id)?.name ?? 'this building';
    const ok = await this.confirm({
      title: `Delete ${name}?`,
      body: () => {
        const fs = store.stack(id).map((f) => f.session);
        const what = fs.length ? `Its ${plural(fs.length, 'floor')} (${fs.join(', ')}) ${fs.length === 1 ? 'goes' : 'go'} back to the unassigned lot.` : 'It has no floors.';
        return `${what} The herdr sessions keep running; only the building goes.`;
      },
      ok: 'Delete building',
      cancel: 'Keep building',
    });
    if (!ok) return;
    const n = store.stack(id).length;
    if (await this.run(`b:${id}`, 'building.delete', { id }, { name })) {
      this.setStatus(n ? `Deleted ${name}. ${plural(n, 'floor')} moved to the unassigned lot.` : `Deleted ${name}.`);
    }
  }

  // ---- settings ----------------------------------------------------------------

  private renderSettings(v: Extract<View, { kind: 'settings' }>, first: boolean): void {
    const f = this.host.store.floorView(v.session);
    if (!f) {
      this.close();
      this.host.toast(`${v.session} is gone.`, 'info');
      return;
    }
    const where = f.level ? `Floor ${f.level.number} of ${f.building?.name ?? ''}` : LOT;
    replaceKeepingFocus(this.head, this.headFor('Floor settings', `${f.session} · ${where}`, h('div', { class: 'lift-display', 'aria-hidden': 'true' }, icon(ICON.gear)), v.from));
    if (!first && this.settingsForm?.session === v.session) return;
    this.settingsForm = this.buildSettings(f);
    this.body.replaceChildren(this.settingsForm.el);
  }

  private buildSettings(f: FloorView): NonNullable<Panels['settingsForm']> {
    const session = f.session;
    const hire = this.host.store.hireOptions;
    const init = formFrom(f.settings, f.suggested);
    const errs = new Map<FieldKey, HTMLElement>();
    const inputs = new Map<FieldKey, HTMLInputElement | HTMLSelectElement>();
    const hints = new Map<FieldKey, string>();

    const field = (key: FieldKey, label: Child[] | string, control: HTMLInputElement | HTMLSelectElement, hint = '', cls = '') => {
      const id = `set-${key}`;
      control.id = id;
      control.name = key;
      inputs.set(key, control);
      const msg = h('p', { class: 'field-hint', id: `${id}-hint` }, hint);
      hints.set(key, hint);
      errs.set(key, msg);
      if (hint) control.setAttribute('aria-describedby', msg.id);
      return h('div', { class: `field${cls}` }, h('label', { for: id }, ...(typeof label === 'string' ? [label] : label)), control, msg);
    };
    const text = (value: string, attrs: Record<string, string> = {}) => h('input', { value, autocomplete: 'off', spellcheck: 'false', ...attrs });
    const select = (options: Array<[string, string]>, value: string) => {
      const s = h('select', {});
      for (const [v, l] of options) s.append(h('option', { value: v, selected: v === value ? true : null }, l));
      s.value = value;
      return s;
    };

    const suggestedTape = h('span', { class: 'tape tape--suggested', title: 'Suggested from the workers’ git remotes' }, 'Suggested');
    const repo = text(init.form.repo, { placeholder: 'owner/repo', 'data-key': 'repo' });
    const repoHint = init.repoSuggested ? 'Suggested from the workers’ git remotes. Save to keep it.' : 'The GitHub repository this floor works on.';
    const repoField = field('repo', ['Repository', init.repoSuggested ? suggestedTape : null], repo, repoHint);
    repo.addEventListener('input', () => {
      if (!init.repoSuggested) return;
      const same = repo.value.trim() === init.form.repo;
      suggestedTape.hidden = !same;
    });

    const owner = text(init.form.projectOwner, { placeholder: init.form.repo.split('/')[0] || 'owner' });
    const number = text(init.form.projectNumber, { inputmode: 'numeric', placeholder: 'e.g. 3' });
    // The status field stands alone (no project needed); the defaults are marked until changed.
    const statusName = text(init.form.statusName, { placeholder: DEFAULT_STATUS_FIELD.name });
    const defaultTape = h('span', { class: 'tape tape--default', title: 'The boards use these until you change them' }, 'Default');
    const statusHint = (isDefault: boolean) =>
      isDefault ? 'The defaults: the boards use these until you change them.' : 'In board order. Remove them all and empty the name to go back to the defaults.';
    const statusMsg = h('p', { class: 'field-hint', id: 'set-statusOptions-hint' }, statusHint(init.statusDefault));
    const statuses = this.statusEditor(init.form.statusOptions, statusMsg.id, () => {
      syncDefault();
      clearError('statusOptions');
    });
    const syncDefault = () => {
      const d = DEFAULT_STATUS_FIELD;
      const v = statuses.values();
      const isDefault = init.statusDefault && statusName.value === d.name && v.length === d.options.length && v.every((o, i) => o === d.options[i]);
      defaultTape.hidden = !isDefault;
      hints.set('statusOptions', statusHint(isDefault));
      if (!statusMsg.classList.contains('field-error')) statusMsg.textContent = statusHint(isDefault);
    };
    statusName.addEventListener('input', syncDefault);
    const statusGroup = h(
      'div',
      { class: 'field-grid field-grid--status' },
      field('statusName', ['Status field', init.statusDefault ? defaultTape : null], statusName, ''),
      h('div', { class: 'field', role: 'group', 'aria-labelledby': 'set-statusOptions-label' }, h('p', { class: 'field-label', id: 'set-statusOptions-label' }, 'Statuses'), statuses.el, statusMsg),
    );
    errs.set('statusOptions', statusMsg);
    hints.set('statusOptions', statusHint(init.statusDefault));

    const cwd = text(init.form.defaultCwd, { placeholder: init.cwdPlaceholder || '/home/…' });
    const cwdHint = init.cwdPlaceholder ? `Empty uses the repo’s root checkout, ${init.cwdPlaceholder}.` : 'An absolute path on the server. Empty: the workers’ own folders.';

    const harness = select([['', 'No default'], ...Object.keys(hire).map((k): [string, string] => [k, k])], init.form.harness);
    const model = select([], '');
    const effort = select([], '');
    const fillModel = (keep: string) => {
      const models = hire[harness.value]?.models ?? [];
      model.replaceChildren(h('option', { value: '' }, harness.value ? 'Choose a model' : '—'), ...models.map((m) => h('option', { value: m }, m)));
      model.value = models.includes(keep) ? keep : '';
      model.disabled = !harness.value;
    };
    const fillEffort = (keep: string) => {
      const efforts = effortsFor(hire, harness.value, model.value);
      effort.replaceChildren(h('option', { value: '' }, model.value ? 'Choose an effort' : '—'), ...efforts.map((m) => h('option', { value: m }, m)));
      effort.value = efforts.includes(keep) ? keep : '';
      effort.disabled = !model.value;
    };
    fillModel(init.form.model);
    fillEffort(init.form.effort);
    harness.addEventListener('change', () => {
      fillModel(model.value);
      fillEffort(effort.value);
    });
    model.addEventListener('change', () => fillEffort(effort.value));

    const unsupported = this.host.unsupported('floor.settings.set');
    const save = h('button', { class: 'btn btn--primary', type: 'submit', 'aria-disabled': unsupported ? 'true' : null, title: unsupported ? failureText('floor.settings.set', 'unknown_command', '') : null }, 'Save settings');
    const cancel = h('button', { class: 'btn', onclick: () => (this.view?.kind === 'settings' && this.view.from ? this.show(this.view.from) : this.close()) }, 'Cancel');

    const form = h(
      'form',
      { class: 'settings', novalidate: true, 'aria-label': `Settings for ${session}` },
      h('fieldset', {}, h('legend', {}, 'Linked GitHub repo'), repoField),
      h(
        'fieldset',
        {},
        h('legend', {}, 'GitHub Project ', h('span', { class: 'legend-note' }, 'optional · for the Issues and PRs boards')),
        h('div', { class: 'field-grid' }, field('projectOwner', 'Owner', owner, ''), field('projectNumber', 'Number', number, '')),
        statusGroup,
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'New hires'),
        field('defaultCwd', 'Default folder', cwd, cwdHint),
        h('div', { class: 'field-grid field-grid--hire' }, field('harness', 'Harness', harness), field('model', 'Model', model), field('effort', 'Effort', effort)),
      ),
      h('div', { class: 'settings-actions' }, cancel, save),
    );

    const read = (): SettingsForm => ({
      repo: repo.value,
      projectOwner: owner.value,
      projectNumber: number.value,
      statusName: statusName.value,
      statusOptions: statuses.values(),
      defaultCwd: cwd.value,
      harness: harness.value,
      model: model.value,
      effort: effort.value,
    });
    const show = (errors: Partial<Record<FieldKey, string>>, badOption: number | null = null) => {
      for (const [k, el] of errs) {
        const e = errors[k];
        const input = inputs.get(k);
        el.textContent = e ?? hints.get(k) ?? '';
        el.classList.toggle('field-error', !!e);
        if (input) {
          input.setAttribute('aria-invalid', e ? 'true' : 'false');
          if (e || hints.get(k)) input.setAttribute('aria-describedby', el.id);
          else input.removeAttribute('aria-describedby');
        }
      }
      statuses.flag(errors.statusOptions ? badOption : null);
    };
    // Editing a flagged field clears its message (any status edit clears the
    // statuses'); the last one clears the banner.
    const clearError = (k: FieldKey) => {
      if (!errs.get(k)?.classList.contains('field-error')) return;
      const still: Partial<Record<FieldKey, string>> = {};
      for (const [key, el] of errs) if (key !== k && el.classList.contains('field-error')) still[key] = el.textContent ?? '';
      show(still);
      if (!Object.keys(still).length) this.setStatus('');
    };
    form.addEventListener('input', (e) => {
      const t = e.target as HTMLElement;
      const k = t.getAttribute('name') as FieldKey | null;
      if (k && (k === 'statusOptions' || t.getAttribute('aria-invalid') === 'true')) clearError(k);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (save.getAttribute('aria-disabled') === 'true') {
        if (this.host.unsupported('floor.settings.set')) this.setStatus(failureText('floor.settings.set', 'unknown_command', ''), 'error');
        return;
      }
      const cur = this.host.store.floorView(session);
      if (!cur) return;
      const p = parseForm(read(), hire, cur.settings);
      show(p.errors, p.badOption);
      const bad = (Object.keys(p.errors) as FieldKey[])[0];
      if (bad) {
        if (bad === 'statusOptions') statuses.focus(p.badOption);
        else inputs.get(bad)?.focus();
        this.setStatus('Fix the highlighted field to save.', 'error');
        return;
      }
      const patch = settingsPatch(cur.settings, p.value);
      if (!Object.keys(patch).length) {
        this.setStatus('Nothing changed, so nothing was saved.');
        return;
      }
      save.setAttribute('aria-disabled', 'true');
      save.textContent = 'Saving…';
      this.setStatus('Saving…');
      void this.host.send('floor.settings.set', { session, ...patch }).then((r) => {
        save.removeAttribute('aria-disabled');
        save.textContent = 'Save settings';
        if (!r.ok) {
          this.setStatus(failureText('floor.settings.set', r.code, r.message, { floor: session }), 'error');
          if (r.code === 'unknown_command') {
            save.setAttribute('aria-disabled', 'true');
            save.title = failureText('floor.settings.set', 'unknown_command', '');
          }
          return;
        }
        // Rebuild from what is stored now: the suggestion mark goes, values normalise.
        const now = this.host.store.floorView(session);
        if (now && this.view?.kind === 'settings' && this.view.session === session) {
          this.settingsForm = this.buildSettings(now);
          this.body.replaceChildren(this.settingsForm.el);
          this.body.querySelector<HTMLElement>('.settings-actions .btn--primary')?.focus();
        }
        const names: Record<string, string> = { repo: 'repo', project: 'project', status_field: 'status field', default_cwd: 'default folder', default_hire: 'default hire' };
        this.setStatus(`Saved the ${Object.keys(patch).map((k) => names[k] ?? k).join(', ')}.`);
      });
    });
    return { el: form, read, session, repoSuggested: init.repoSuggested, statusDefault: init.statusDefault };
  }

  /**
   * The status list: one input per status, in board order, with buttons to
   * move and remove each and to add one. A row per label keeps any label
   * intact (commas and all); rows persist, so typing and focus survive a move.
   */
  private statusEditor(
    initial: string[],
    hintId: string,
    changed: () => void,
  ): { el: HTMLElement; values(): string[]; flag(row: number | null): void; focus(row: number | null): void } {
    interface Row {
      li: HTMLLIElement;
      num: HTMLElement;
      input: HTMLInputElement;
      up: HTMLButtonElement;
      down: HTMLButtonElement;
      del: HTMLButtonElement;
    }
    let seq = 0;
    const rows: Row[] = [];
    const list = h('ol', { class: 'opts', 'aria-labelledby': 'set-statusOptions-label' });
    const empty = h('li', { class: 'dir-empty' }, 'No statuses.');
    // aria-disabled, not disabled: a button that reaches the end keeps focus.
    const tool = (paths: string, key: string, fn: () => void, extra = '') => {
      const b = h('button', { class: `btn btn--icon btn--sm${extra}`, 'data-key': key }, icon(paths));
      b.addEventListener('click', () => b.getAttribute('aria-disabled') !== 'true' && fn());
      return b;
    };
    const add = h('button', { class: 'btn btn--sm opts-add', 'data-key': 'opt-add' }, icon(ICON.plus), h('span', {}, 'Add status'));
    const off = (b: HTMLElement, yes: boolean) => {
      if (yes) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    };
    const names = (r: Row, i: number) => {
      const what = r.input.value.trim() ? `“${r.input.value.trim()}”` : `status ${i + 1}`;
      r.input.setAttribute('aria-label', `Status ${i + 1} of ${rows.length}`);
      for (const [b, label] of [
        [r.up, `Move ${what} up`],
        [r.down, `Move ${what} down`],
        [r.del, `Remove ${what}`],
      ] as const) {
        b.setAttribute('aria-label', label);
        b.title = label;
      }
    };
    const layout = () => {
      const a = document.activeElement;
      list.replaceChildren(...(rows.length ? rows.map((r) => r.li) : [empty]));
      rows.forEach((r, i) => {
        r.num.textContent = String(i + 1);
        names(r, i);
        off(r.up, i === 0);
        off(r.down, i === rows.length - 1);
      });
      off(add, rows.length >= 20);
      add.title = rows.length >= 20 ? 'At most 20 statuses' : 'Add a status at the end';
      // Moving a node drops its focus: put it back.
      if (a instanceof HTMLElement && a !== document.activeElement && a.isConnected) a.focus();
    };
    const make = (text: string): Row => {
      const id = seq++;
      const input = h('input', { 'data-key': `opt:${id}`, name: 'statusOptions', value: text, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': hintId });
      const r: Row = {
        li: h('li', { class: 'opt' }),
        num: h('span', { class: 'opt-num', 'aria-hidden': 'true' }),
        input,
        up: tool(ICON.up, `oup:${id}`, () => move(r, -1)),
        down: tool(ICON.down, `odown:${id}`, () => move(r, 1)),
        del: tool(ICON.trash, `odel:${id}`, () => remove(r), ' btn--danger-quiet'),
      };
      input.addEventListener('input', () => names(r, rows.indexOf(r)));
      r.li.append(r.num, input, h('div', { class: 'dir-tools' }, r.up, r.down, r.del));
      return r;
    };
    const move = (r: Row, dir: -1 | 1) => {
      const i = rows.indexOf(r);
      const other = rows[i + dir];
      if (!other) return;
      rows[i + dir] = r;
      rows[i] = other;
      layout();
      changed();
    };
    const remove = (r: Row) => {
      const i = rows.indexOf(r);
      rows.splice(i, 1);
      layout();
      (rows[i]?.input ?? rows[i - 1]?.input ?? add).focus();
      changed();
    };
    add.addEventListener('click', () => {
      if (add.getAttribute('aria-disabled') === 'true') return;
      const r = make('');
      rows.push(r);
      layout();
      r.input.focus();
      changed();
    });
    for (const t of initial) rows.push(make(t));
    layout();
    return {
      el: h('div', { class: 'opts-editor' }, list, add),
      values: () => rows.map((r) => r.input.value),
      flag: (row) => rows.forEach((r, i) => r.input.setAttribute('aria-invalid', i === row ? 'true' : 'false')),
      focus: (row) => (rows[row ?? 0]?.input ?? add).focus(),
    };
  }

  // ---- confirmation --------------------------------------------------------------

  private confirm(o: { title: string; body: () => string; ok: string; cancel: string }): Promise<boolean> {
    this.endConfirm(false);
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise<boolean>((resolve) => {
      this.confirmState = {
        title: o.title,
        body: o.body,
        resolve: (ok) => {
          resolve(ok);
          if (back?.isConnected) back.focus();
        },
      };
      const cancel = h('button', { class: 'btn', onclick: () => this.endConfirm(false) }, o.cancel);
      const ok = h('button', { class: 'btn btn--danger', onclick: () => this.endConfirm(true) }, o.ok);
      this.confirmEl.replaceChildren(
        h('div', { class: 'sheet-body' }, h('h2', { id: 'confirm-title' }, o.title), h('p', { id: 'confirm-body' }, o.body()), h('div', { class: 'sheet-actions' }, cancel, ok)),
      );
      this.confirmEl.showModal();
      cancel.focus();
    });
  }

  /** Answers the open confirmation (if any) and closes it. */
  private endConfirm(ok: boolean): void {
    const c = this.confirmState;
    this.confirmState = null;
    if (this.confirmEl.open) this.confirmEl.close();
    c?.resolve(ok);
  }

  private renderConfirmBody(): void {
    const p = this.confirmEl.querySelector('#confirm-body');
    const c = this.confirmState;
    if (p && c) {
      const t = c.body();
      if (p.textContent !== t) p.textContent = t;
    }
  }

  // ---- test hook -----------------------------------------------------------------

  summary(): PanelSummary | null {
    const v = this.view;
    if (!v || !this.dialog.open) return null;
    const confirm = this.confirmState ? { title: this.confirmState.title, body: this.confirmState.body() } : null;
    const base = { status: this.statusText, confirm };
    const store = this.host.store;
    if (v.kind === 'elevator') return { kind: 'elevator', building: v.building, title: this.elevatorTitle(v.building), rows: this.rows(v.building), ...base };
    if (v.kind === 'buildings') {
      return {
        kind: 'buildings',
        buildings: store.sortedBuildings().map((b) => ({ id: b.id, name: b.name, floors: store.stack(b.id).map((f) => f.session) })),
        lot: store.stack(null).map((f) => f.session),
        ...base,
      };
    }
    const sf = this.settingsForm;
    return {
      kind: 'settings',
      session: v.session,
      form: sf ? sf.read() : formFrom({}, {}).form,
      repoSuggested: sf?.repoSuggested ?? false,
      statusDefault: sf?.statusDefault ?? false,
      ...base,
    };
  }
}

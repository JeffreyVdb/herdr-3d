import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName } from '../net/protocol';
import { buildingOrder, floorMove } from '../world/arrange';
import { DEFAULT_STATUS_FIELD, effortsFor, formFrom, parseForm, settingsPatch, type FieldKey, type SettingsForm, type StatusRow } from '../world/settings';
import { floorName, type FloorView, type StoredFloor, type WorldStore } from '../world/store';
import { h, icon, ICON, replaceKeepingFocus, type Child } from './dom';
import { LOGO_ACCEPT, precheckLogo } from '../net/logo';
import { logoHashOf } from '../net/protocol';
import { failureText } from './messages';
import { KaneoPicker } from './kaneoFloor';
import { backdropPolicy } from './dismiss';
import { offeredOptions } from '../world/hire';
import { labelsOf, modelEntries, modelOptionText } from '../world/modelLabel';
import type { HireModelPrefs } from './hireModelPrefs';

/**
 * The M3 panels over the HUD: the elevator (a building's floors, travel,
 * wake / sleep), the buildings directory (create, rename, delete, arrange)
 * and floor settings, plus a confirmation sheet for destructive actions.
 * One modal <dialog> at a time (the confirmation stacks on top of it);
 * live world changes re-render the open list in place, keeping focus.
 */

export interface PanelHost {
  readonly store: WorldStore;
  /** The floor the player is on, null in the city (and in the lobby, on the street, on the fire escape). */
  here(): string | null;
  /** The player is in a lobby (of the building the panel shows). */
  inLobby(): boolean;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The bridge answered `unknown_command` for it before. */
  unsupported(t: CommandName): boolean;
  /** Close the panels and ride the elevator to a floor (an id). */
  travel(floor: string): void;
  /** Close the panels and ride the elevator down to a building's lobby (null: the unassigned lot's). */
  travelLobby(building: string | null): void;
  /** HUD toast, for results that arrive after the panel closed. */
  toast(msg: string, kind: 'info' | 'error'): void;
  /** M3d: where a building's logo image is fetched from (it carries the token and the hash). */
  logoUrl(building: string, hash: string): string;
  /** M3d: the game tried to load the logo behind this hash and could not (the signs show the name). */
  logoFailed(hash: string): boolean;
  /** M3d: sends a logo file for a building / removes it (HTTP; the world then says the new hash). */
  setLogo(building: string, file: File): Promise<CommandResult>;
  clearLogo(building: string): Promise<CommandResult>;
  /** Settings → Harness models: the default-hire model picker offers the models it leaves shown (absent: every model). */
  modelPrefs?: HireModelPrefs;
  /** #58: opens the Add floor dialog (absent: the Buildings panel offers none). */
  addFloor?(from: HTMLElement): void;
}

type View = { kind: 'elevator'; building: string | null } | { kind: 'buildings' } | { kind: 'settings'; floor: string; from: View | null };

export interface ElevatorRow {
  /** #58: the floor id. */
  floor: string;
  /** #58: the floor's name. */
  name: string;
  /** #58: the floor is a virtual floor. */
  virtual: boolean;
  /** From the ground, null in the lot. */
  number: number | null;
  state: 'running' | 'asleep';
  transition: 'waking' | 'sleeping' | null;
  counts: { working: number; needsYou: number; idle: number; waiting: number; total: number };
  current: boolean;
  /** Wake / sleep button on this row. */
  action: 'wake' | 'sleep' | null;
  resume: FloorView['resume'];
}

/** What the open panel shows (test hook `window.__h3d.panel()`). */
export type PanelSummary = (
  | { kind: 'elevator'; building: string | null; title: string; rows: ElevatorRow[]; lobby: { current: boolean } | null; /** M5: the floor N preselected. */ pick?: string }
  | { kind: 'buildings'; buildings: Array<{ id: string; name: string; floors: string[]; logo: string | null; logoBusy: string | null }>; lot: string[] }
  | { kind: 'settings'; floor: string; form: ShownForm; repoSuggested: boolean; statusDefault: boolean }
) & { status: string; confirm: { title: string; body: string } | null };

/** The settings form as its inputs show it: each status by its text. */
type ShownForm = Omit<SettingsForm, 'statusOptions'> & { statusOptions: string[] };

const LOT = 'Unassigned lot';
const LOGO_SHOWN = 'Shown on the entrance sign, the reception wall and the city.';
const LOGO_UNLOADED = 'Saved, but the image could not be loaded — showing the name. It will retry on reconnect.';

function stateOf(v: FloorView): ElevatorRow['state'] {
  return v.asleep ? 'asleep' : 'running';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
export function namesList(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * #58: the wake / sleep button of a floor. Wake and sleep are its herdr session's (`all`: every floor on it), so on a
 * floor that shares its session the button says "session" and its label names every floor it wakes or puts to sleep;
 * on a virtual floor, which session that is.
 */
export function wakeSleepWords(f: Pick<FloorView, 'name' | 'virtual' | 'baseSession'>, all: readonly Pick<StoredFloor, 'name' | 'session' | 'virtual' | 'id'>[], kind: 'wake' | 'sleep'): { text: string; title: string; aria: string } {
  const verb = kind === 'wake' ? 'Wake' : 'Sleep';
  if (all.length < 2 && !f.virtual) {
    return {
      text: `${verb} floor`,
      title: kind === 'wake' ? `Start ${f.name}'s herdr server and resume its agents` : `Stop ${f.name}'s herdr session; its agents resume on the next wake`,
      aria: `${verb} floor ${f.name}`,
    };
  }
  const names = namesList(all.map(floorName));
  return {
    text: `${verb} session`,
    title:
      kind === 'wake'
        ? `${f.virtual ? `${f.name} is a virtual floor on herdr session ${f.baseSession}: waking it starts that session` : `Start herdr session ${f.baseSession}`} and wakes every floor on it: ${names}`
        : `${f.virtual ? `${f.name} is a virtual floor on herdr session ${f.baseSession}: ` : ''}stops herdr session ${f.baseSession} and puts every floor on it to sleep: ${names}`,
    aria: `${verb} session ${f.baseSession} (${names})`,
  };
}

function countsText(v: FloorView): string {
  if (v.asleep) return `asleep, ${plural(v.counts.total, 'worker')}`;
  const waiting = v.counts.waiting > 0 ? `, ${v.counts.waiting} waiting on background tasks` : '';
  return `${v.counts.working} working, ${v.counts.needsYou} need you, ${v.counts.idle} idle${waiting}`;
}

function countChips(v: FloorView): HTMLElement {
  const c = v.counts;
  const item = (cls: string, n: number, label: string) => h('span', { class: `count count--${cls}` }, h('i'), h('b', {}, String(n)), h('span', {}, label));
  return h('span', { class: 'lift-counts', 'aria-hidden': 'true' }, item('working', c.working, 'working'), item('needs_you', c.needsYou, 'need you'), item('idle', c.idle, 'idle'), ...(c.waiting > 0 ? [item('waiting', c.waiting, 'waiting')] : []));
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
  /** Commands in flight, by what they are about (`floor:<floor id>`, `b:<id>`, `f:<floor id>`). */
  private readonly busy = new Map<string, string>();
  private renaming: { id: string; value: string; error: string } | null = null;
  private moving: string | null = null;
  private list: HTMLElement | null = null;
  private settingsForm: { el: HTMLFormElement; read(): SettingsForm; floor: string; repoSuggested: boolean; statusDefault: boolean; dispose(): void } | null = null;
  private confirmState: { title: string; body: () => string; resolve(ok: boolean): void } | null = null;
  private statusText = '';
  /** M5: the floor N preselected in the elevator, with why. */
  private pick: { floor: string; note: string } | null = null;
  /** M3d: the one file input all the "Set logo" buttons use, and the building it is for. */
  private readonly logoInput = h('input', { type: 'file', accept: LOGO_ACCEPT, hidden: true, tabindex: '-1', 'aria-hidden': 'true', 'data-key': 'logo-file' });
  private logoFor: string | null = null;
  /** M3d: a chosen file, shown in the thumbnail while it uploads (object URLs, by building). */
  private readonly logoPreview = new Map<string, string>();

  constructor(
    parent: HTMLElement,
    private readonly host: PanelHost,
  ) {
    this.dialog.append(this.head, this.body, this.statusEl, this.alertEl, this.logoInput);
    this.alertEl.hidden = true;
    this.logoInput.addEventListener('change', () => {
      const id = this.logoFor;
      const file = this.logoInput.files?.[0];
      this.logoInput.value = '';
      if (id && file) void this.uploadLogo(id, file);
    });
    this.dialog.addEventListener('close', () => {
      // `close` is queued: the panel may have been opened again since.
      if (this.dialog.open) return;
      this.view = null;
      this.pick = null;
      this.renaming = null;
      this.moving = null;
      this.setSettingsForm(null);
      this.list = null;
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
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

  /** M5: `pick` preselects a floor (N: someone there needs you), its note shown on the row and as the status. */
  openElevator(building: string | null, pick?: { floor: string; note: string }): void {
    this.pick = pick ?? null;
    this.show({ kind: 'elevator', building });
    if (pick) this.setStatus(pick.note);
  }

  /** #58: `added` is a floor just made: its Move menu opens, to put it into a building. */
  openBuildings(added?: string): void {
    this.show({ kind: 'buildings' });
    if (!added || !this.host.store.floors.has(added)) return;
    this.moving = added;
    this.setStatus(`Added ${this.host.store.floorName(added)}. It is in the ${LOT}: pick a building to move it into.`);
    this.refresh();
    this.list?.querySelector<HTMLElement>(`[data-key^="to:${CSS.escape(added)}:"]`)?.focus();
  }

  openSettings(floor: string): void {
    this.show({ kind: 'settings', floor, from: this.view && this.view.kind !== 'settings' ? this.view : null });
  }

  /** Building (id, or null for the lot) a floor belongs to, as the city shows it. */
  buildingOf(floor: string): string | null {
    const b = this.host.store.floors.get(floor)?.building ?? null;
    return b !== null && this.host.store.buildings.has(b) ? b : null;
  }

  private show(v: View): void {
    this.view = v;
    this.renaming = null;
    this.moving = null;
    this.setSettingsForm(null);
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
    const picked = v.kind === 'elevator' && this.pick ? this.body.querySelector<HTMLElement>(`[data-key="go:${CSS.escape(this.pick.floor)}"]`) : null;
    if (picked) el = picked;
    else if (v.kind === 'elevator') el = this.body.querySelector<HTMLElement>('.lift-go[aria-current="location"]') ?? this.body.querySelector<HTMLElement>('.lift-go');
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
      floor: f.id,
      name: f.name,
      virtual: f.virtual,
      number: f.level?.number ?? null,
      state: stateOf(f),
      transition: f.transition,
      counts: { working: f.counts.working, needsYou: f.counts.needsYou, idle: f.counts.idle, waiting: f.counts.waiting, total: f.counts.total },
      current: f.id === here,
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
    const hereView = here ? floors.find((f) => f.id === here) : undefined;
    const key = JSON.stringify([
      building,
      this.elevatorTitle(building),
      here,
      [...this.busy],
      floors.map((f) => [f.id, f.name, f.level?.number, f.asleep, f.transition, f.counts, f.workers.map((w) => [w.name, w.worker.resume ?? ''])]),
      this.host.unsupported('floor.wake'),
      this.host.unsupported('floor.sleep'),
      this.host.inLobby(),
      this.pick,
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
        : `${plural(floors.length, 'floor')} · ${hereView ? `you are on ${hereView.level ? `floor ${hereView.level.number}` : hereView.name}` : this.host.inLobby() ? 'you are in the lobby' : building === null ? 'sessions in no building' : 'top floor first'}`;
    replaceKeepingFocus(this.head, this.headFor(this.elevatorTitle(building), sub, display, null));

    if (!floors.length) {
      replaceKeepingFocus(this.body, [h('p', { class: 'panel-empty' }, building === null ? 'Every floor is in a building.' : 'Move floors here from the Buildings panel.')]);
      return;
    }
    const list = h('ol', { class: 'lift-floors', 'aria-label': 'Floors, top to bottom' });
    for (const f of floors) list.append(this.elevatorRow(f, f.id === here));
    list.append(this.lobbyRow(building, this.host.inLobby()));
    replaceKeepingFocus(this.body, [list]);
  }

  /** The Lobby stop under the floors: reception, and the front door onto the street. */
  private lobbyRow(building: string | null, current: boolean): HTMLElement {
    const go = h(
      'button',
      {
        class: 'lift-go',
        'data-key': 'go:lobby',
        'aria-label': `Lobby: reception and the front door. ${current ? 'You are here.' : 'Go there.'}`,
        'aria-current': current ? 'location' : null,
        onclick: () => (current ? this.close() : this.host.travelLobby(building)),
        onkeydown: (e: Event) => this.rowKeys(e as KeyboardEvent),
      },
      h('span', { class: 'lift-num lift-num--lobby' }, 'L'),
      h(
        'span',
        { class: 'lift-name' },
        h('span', { class: 'lift-title' }, h('span', { class: 'lift-session' }, 'Lobby'), current ? h('span', { class: 'lift-here' }, 'You are here') : null),
        h('span', { class: 'lift-lobby-note' }, 'Reception · the front door onto the street'),
      ),
    );
    return h('li', { class: 'lift-row lift-row--lobby', 'data-lobby': 'true' }, go);
  }

  private elevatorRow(f: FloorView, current: boolean): HTMLElement {
    const num = f.level ? String(f.level.number) : '';
    const state = f.transition ? TRANSITION_TAPE[f.transition].toLowerCase() : countsText(f);
    const label = `${num ? `Floor ${num}, ` : ''}${f.name}: ${state}. ${current ? 'You are here.' : 'Go there.'}`;
    const meta: Child = f.transition
      ? h('span', { class: `tape tape--${f.transition}` }, TRANSITION_TAPE[f.transition])
      : f.asleep
        ? h('span', { class: 'lift-asleep' }, h('span', { class: 'tape tape--asleep' }, 'Asleep'), h('span', {}, plural(f.counts.total, 'worker')))
        : countChips(f);
    const go = h(
      'button',
      {
        class: 'lift-go',
        'data-key': `go:${f.id}`,
        'aria-label': label,
        'aria-current': current ? 'location' : null,
        title: f.floor.error ? `This floor cannot be read: ${f.floor.error}` : null,
        onclick: () => this.goTo(f.id),
        onkeydown: (e: Event) => this.rowKeys(e as KeyboardEvent),
      },
      h('span', { class: 'lift-num', 'data-empty': num ? null : 'true' }, num),
      h(
        'span',
        { class: 'lift-name' },
        h(
          'span',
          { class: 'lift-title' },
          h('span', { class: 'lift-session' }, f.name),
          current ? h('span', { class: 'lift-here' }, 'You are here') : null,
          // M5: N picked this floor: someone here needs you.
          this.pick?.floor === f.id ? h('span', { class: 'tape tape--needs_you lift-need' }, 'Next up') : null,
        ),
        meta,
      ),
    );
    const actions = h('div', { class: 'lift-actions' });
    const busy = this.busy.get(`floor:${f.id}`);
    const wakeSleep = f.transition ? null : f.asleep ? 'wake' : 'sleep';
    const t: CommandName = wakeSleep === 'wake' ? 'floor.wake' : 'floor.sleep';
    if (busy || f.transition) {
      actions.append(h('button', { class: 'btn btn--sm', 'aria-disabled': 'true', 'data-key': `ws:${f.id}` }, busy ?? (f.transition === 'waking' ? 'Waking…' : 'Going to sleep…')));
    } else if (wakeSleep) {
      const no = this.host.unsupported(t);
      // #58: wake and sleep are the session's: on a floor that shares it (a virtual floor, or a real one with virtual
      // floors) the button says so, and names every floor it wakes or puts to sleep.
      const ws = wakeSleepWords(f, this.host.store.sessionFloors(f.baseSession), wakeSleep);
      actions.append(
        h(
          'button',
          {
            class: `btn btn--sm${wakeSleep === 'wake' ? ' btn--wake' : ''}`,
            'data-key': `ws:${f.id}`,
            'aria-disabled': no ? 'true' : null,
            title: no ? failureText(t, 'unknown_command', '') : ws.title,
            'aria-label': ws.aria,
            onclick: () => (no ? this.notify(failureText(t, 'unknown_command', ''), 'error') : wakeSleep === 'wake' ? void this.wake(f.id) : void this.sleep(f.id)),
          },
          icon(wakeSleep === 'wake' ? ICON.sun : ICON.moon),
          h('span', {}, ws.text),
        ),
      );
    }
    actions.append(
      h(
        'button',
        { class: 'btn btn--sm', 'data-key': `set:${f.id}`, 'aria-label': `Settings for ${f.name}`, onclick: () => this.openSettings(f.id) },
        icon(ICON.gear),
        h('span', {}, 'Settings'),
      ),
    );
    const li = h('li', { class: 'lift-row', 'data-floor': f.id, 'data-session': f.baseSession, 'data-state': stateOf(f), 'data-transition': f.transition }, go, actions);
    const progress = this.progress(f);
    if (progress) li.append(progress);
    return li;
  }

  /** Wake / sleep progress under a row: what is happening, and each worker's resume. */
  private progress(f: FloorView): HTMLElement | null {
    const r = f.resume;
    if (!f.transition && !r) return null;
    const box = h('div', { class: 'lift-progress', 'data-key': `progress:${f.id}` });
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
          { class: 'lift-bar', role: 'progressbar', 'aria-label': `Agents resumed on ${f.name}`, 'aria-valuemin': 0, 'aria-valuemax': r.total, 'aria-valuenow': done },
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

  private goTo(floor: string): void {
    if (floor === this.host.here()) {
      this.close();
      return;
    }
    this.host.travel(floor);
  }

  private async wake(floor: string): Promise<void> {
    const k = `floor:${floor}`;
    if (this.busy.has(k)) return;
    const store = this.host.store;
    const name = store.floorName(floor);
    // #58: a floor's wake is its session's: every floor on it wakes.
    const all = store.sessionFloors(store.floors.get(floor)?.base_session ?? floor);
    const what = all.length > 1 ? namesList(all.map(floorName)) : name;
    this.busy.set(k, 'Waking…');
    this.setStatus(`Waking ${what}…`);
    this.refresh();
    const r = await this.host.send('floor.wake', { floor });
    this.busy.delete(k);
    if (r.ok) {
      const ws = (r.data as { workers?: Array<{ resume?: string }> } | undefined)?.workers ?? [];
      const n = (s: string) => ws.filter((w) => w.resume === s).length;
      const parts = [n('confirmed') && `${n('confirmed')} resumed`, n('fallback') && `${n('fallback')} relaunched`, n('failed') && `${n('failed')} did not resume`].filter(Boolean);
      this.notify(`${what} ${all.length > 1 ? 'are' : 'is'} awake${parts.length ? `: ${parts.join(', ')}` : ''}.`, n('failed') ? 'error' : 'info');
    } else this.notify(failureText('floor.wake', r.code, r.message, { floor: name }), 'error');
    this.refresh();
  }

  private async sleep(floor: string): Promise<void> {
    const k = `floor:${floor}`;
    if (this.busy.has(k)) return;
    const store = this.host.store;
    const name = store.floorName(floor);
    const session = store.floors.get(floor)?.base_session ?? floor;
    // #58: a floor's sleep is its session's: the confirmation lists every floor it puts to sleep.
    const all = () => store.sessionFloors(session);
    const shared = all().length > 1;
    const ok = await this.confirm({
      title: shared ? `Put ${namesList(all().map(floorName))} to sleep?` : `Put ${name} to sleep?`,
      body: () => {
        const views = all()
          .map((f) => store.floorView(f.id))
          .filter((v): v is FloorView => v !== null);
        const c = views.reduce((a, v) => ({ working: a.working + v.counts.working, needsYou: a.needsYou + v.counts.needsYou }), { working: 0, needsYou: 0 });
        const now =
          !c.working && !c.needsYou
            ? 'No agent is working or waiting on you right now.'
            : `${plural(c.working, 'agent is', 'agents are')} working and ${plural(c.needsYou, 'needs', 'need')} you right now.`;
        const floors = shared ? `These floors share herdr session ${session} and all go to sleep: ${views.map((v) => v.name).join(', ')}. ` : '';
        return `${floors}${now} herdr saves and stops the session; the agents pick their conversations back up when you wake the floor.`;
      },
      ok: shared ? `Sleep ${plural(all().length, 'floor')}` : 'Sleep floor',
      cancel: 'Keep running',
    });
    if (!ok) return;
    const what = shared ? namesList(all().map(floorName)) : name;
    this.busy.set(k, 'Going to sleep…');
    this.setStatus(`Putting ${what} to sleep…`);
    this.refresh();
    const r = await this.host.send('floor.sleep', { floor });
    this.busy.delete(k);
    if (r.ok) this.notify(shared ? `${what} are asleep. Their agents resume when you wake them.` : `${what} is asleep. Its agents resume when you wake it.`);
    else this.notify(failureText('floor.sleep', r.code, r.message, { floor: name }), 'error');
    this.refresh();
  }

  // ---- buildings ---------------------------------------------------------------

  private renderBuildings(): void {
    const store = this.host.store;
    const bs = store.sortedBuildings();
    const lot = store.stack(null);
    const key = JSON.stringify([
      bs.map((b) => [b.id, b.name, logoHashOf(b), this.logoPreview.has(b.id), store.stack(b.id).map((f) => [f.id, f.name, f.virtual, f.floor.index, f.asleep])]),
      lot.map((f) => [f.id, f.name, f.virtual, f.asleep]),
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
    return h('section', { class: 'dir-building', 'data-id': id, 'aria-label': name }, head, this.logoRow(id, name), list);
  }

  /** M3d: the building's logo: a thumbnail, and Set / Change / Clear. */
  private logoRow(id: string, name: string): HTMLElement {
    const hash = logoHashOf(this.host.store.buildings.get(id));
    const busy = this.busy.get(`l:${id}`);
    const src = this.logoPreview.get(id) ?? (hash ? this.host.logoUrl(id, hash) : null);
    const holder = h('span', { class: 'logo-thumb', 'aria-hidden': src ? null : 'true' });
    const placeholder = () => h('span', { class: 'logo-thumb-empty' }, icon(ICON.image));
    if (src) {
      const img = h('img', { src, alt: `Logo of ${name}`, decoding: 'async' });
      img.addEventListener('error', () => {
        holder.replaceChildren(placeholder(), h('span', { class: 'visually-hidden' }, 'The logo could not be loaded'));
        if (hash && !busy && !this.logoPreview.has(id)) {
          stateEl.textContent = LOGO_UNLOADED;
          stateEl.classList.add('logo-state--error');
        }
      });
      holder.append(img);
    } else holder.append(placeholder());
    const failed = !!hash && !this.logoPreview.has(id) && this.host.logoFailed(hash);
    const state = busy ?? (failed ? LOGO_UNLOADED : hash ? LOGO_SHOWN : 'None yet: the signs show the name.');
    const stateEl = h('p', { class: `logo-state${failed ? ' logo-state--error' : ''}` }, state);
    const disabled = !!busy;
    const set = h(
      'button',
      {
        class: `btn btn--sm${hash ? '' : ' btn--primary'}`,
        'data-key': `logo-set:${id}`,
        'aria-disabled': disabled ? 'true' : null,
        'aria-label': `${hash ? 'Change' : 'Set'} the logo of ${name}`,
        onclick: () => {
          if (disabled) return;
          this.logoFor = id;
          this.logoInput.click();
        },
      },
      icon(ICON.image),
      h('span', {}, busy ? 'Working…' : hash ? 'Change logo' : 'Set logo'),
    );
    const tools = h('div', { class: 'logo-tools' }, set);
    if (hash) {
      tools.append(
        h(
          'button',
          {
            class: 'btn btn--sm',
            'data-key': `logo-clear:${id}`,
            'aria-disabled': disabled ? 'true' : null,
            'aria-label': `Clear the logo of ${name}`,
            onclick: () => {
              if (!disabled) void this.clearLogo(id, name);
            },
          },
          icon(ICON.close),
          h('span', {}, 'Clear'),
        ),
      );
    }
    return h('div', { class: 'dir-logo', 'data-logo': hash ?? '' }, holder, h('div', { class: 'logo-text' }, h('p', { class: 'logo-title' }, 'Logo'), stateEl, tools));
  }

  private async uploadLogo(id: string, file: File): Promise<void> {
    const name = this.host.store.buildings.get(id)?.name ?? 'the building';
    const focusSet = () => this.list?.querySelector<HTMLElement>(`[data-key="logo-set:${CSS.escape(id)}"]`)?.focus();
    const why = precheckLogo(file);
    if (why) {
      this.notify(why, 'error');
      return;
    }
    const k = `l:${id}`;
    if (this.busy.has(k)) return;
    this.busy.set(k, 'Uploading…');
    this.logoPreview.set(id, URL.createObjectURL(file));
    this.setStatus(`Uploading the logo for ${name}…`);
    this.refresh();
    const r = await this.host.setLogo(id, file);
    this.busy.delete(k);
    const url = this.logoPreview.get(id);
    this.logoPreview.delete(id);
    if (url) URL.revokeObjectURL(url);
    if (r.ok) this.notify(`Logo saved for ${name}.`);
    else this.notify(failureText('logo.set', r.code, r.message, { name }), 'error');
    this.refresh();
    focusSet();
  }

  private async clearLogo(id: string, name: string): Promise<void> {
    const k = `l:${id}`;
    if (this.busy.has(k)) return;
    this.busy.set(k, 'Clearing…');
    this.setStatus(`Clearing the logo of ${name}…`);
    this.refresh();
    const r = await this.host.clearLogo(id);
    this.busy.delete(k);
    if (r.ok) this.notify(`Cleared the logo of ${name}. The signs show its name again.`);
    else this.notify(failureText('logo.clear', r.code, r.message, { name }), 'error');
    this.refresh();
    this.list?.querySelector<HTMLElement>(`[data-key="logo-set:${CSS.escape(id)}"]`)?.focus();
  }

  private lotBlock(lot: FloorView[]): HTMLElement {
    const list = h('ol', { class: 'dir-floors', 'aria-label': 'Floors in the unassigned lot' });
    lot.forEach((f, j) => list.append(this.floorItem(f, null, j, lot.length)));
    if (!lot.length) list.append(h('li', { class: 'dir-empty' }, 'Every floor is in a building.'));
    return h(
      'section',
      { class: 'dir-building dir-building--lot', 'aria-label': LOT },
      h(
        'div',
        { class: 'dir-bhead' },
        h('h3', { class: 'dir-bname' }, LOT),
        h('span', { class: 'dir-bcount' }, `${plural(lot.length, 'floor')} · sessions in no building`),
        // #58: a new floor starts here.
        this.host.addFloor
          ? h(
              'div',
              { class: 'dir-tools' },
              h('button', { class: 'btn btn--sm', 'data-key': 'add-floor', onclick: (e: Event) => this.host.addFloor?.(e.currentTarget as HTMLElement) }, icon(ICON.plus), h('span', {}, 'Add floor')),
            )
          : null,
      ),
      list,
    );
  }

  private floorItem(f: FloorView, building: string | null, j: number, n: number): HTMLElement {
    const s = f.id;
    const name = f.name;
    const busy = this.busy.has(`f:${s}`);
    const tools = h('div', { class: 'dir-tools' });
    if (building !== null) {
      tools.append(
        this.tool(`Move ${name} up a floor`, ICON.up, `fup:${s}`, () => void this.moveFloor(s, building, -1), busy || j === 0),
        this.tool(`Move ${name} down a floor`, ICON.down, `fdown:${s}`, () => void this.moveFloor(s, building, 1), busy || j === n - 1),
      );
    }
    tools.append(
      h(
        'button',
        {
          class: 'btn btn--sm',
          'data-key': `move:${s}`,
          'aria-expanded': this.moving === s ? 'true' : 'false',
          // #58 decision 4: a virtual floor stays in its session's building: its menu only reorders it there.
          'aria-label': f.virtual ? `Move ${name} within ${building === null ? LOT : (this.host.store.buildings.get(building)?.name ?? 'its building')}` : `Move ${name} to another building`,
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
      { class: 'dir-floor', 'data-floor': s, 'data-session': f.baseSession },
      h('span', { class: 'lift-num lift-num--sm', 'data-empty': f.level ? null : 'true', 'aria-hidden': 'true' }, f.level ? String(f.level.number) : ''),
      h('span', { class: 'dir-fname' }, h('span', { class: 'visually-hidden' }, f.level ? `Floor ${f.level.number}: ` : ''), name),
      f.asleep ? h('span', { class: 'tape tape--asleep' }, 'Asleep') : h('span', { class: 'dir-fstate' }, plural(f.counts.total, 'worker')),
      tools,
    );
    if (this.moving === s && f.virtual) {
      li.append(this.virtualMoveMenu(f, building, j, n, busy));
    } else if (this.moving === s) {
      const menu = h('div', { class: 'dir-move', role: 'group', 'aria-label': `Move ${name} to` }, h('span', { class: 'dir-move-label' }, 'Move to'));
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

  /**
   * #58 decision 4: a virtual floor's Move menu. It stands in its session's floor's building (and goes where that floor
   * goes), so the menu offers no building and no lot: only up and down within that building.
   */
  private virtualMoveMenu(f: FloorView, building: string | null, j: number, n: number, busy: boolean): HTMLElement {
    const s = f.id;
    const where = building === null ? LOT : (this.host.store.buildings.get(building)?.name ?? 'its building');
    const menu = h('div', { class: 'dir-move', role: 'group', 'aria-label': `Move ${f.name} within ${where}` }, h('span', { class: 'dir-move-label' }, `Within ${where}`));
    if (building !== null) {
      const step = (dir: -1 | 1, label: string, off: boolean) =>
        h('button', { class: 'btn btn--sm', 'data-key': `to:${s}:${dir < 0 ? 'up' : 'down'}`, 'aria-disabled': off ? 'true' : null, onclick: () => (off ? undefined : void this.moveFloor(s, building, dir)) }, label);
      menu.append(step(-1, 'Up a floor', busy || j === 0), step(1, 'Down a floor', busy || j === n - 1));
    }
    menu.append(
      h('span', { class: 'dir-move-label', 'data-key': `to:${s}:note` }, `A virtual floor stays with session ${f.baseSession}'s floor${building === null ? ', in the lot' : ''}.`),
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
    return menu;
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

  private async moveFloor(floor: string, building: string, dir: -1 | 1): Promise<void> {
    const args = floorMove(this.host.store.stack(building), floor, building, dir);
    if (!args) return;
    const name = this.host.store.floorName(floor);
    if (await this.run(`f:${floor}`, 'floor.assign', args, { floor: name })) {
      this.setStatus(`Moved ${name} ${dir < 0 ? 'up' : 'down'} a floor.`);
    }
  }

  private async assign(floor: string, building: string | null, buildingName: string): Promise<void> {
    this.moving = null;
    const name = this.host.store.floorName(floor);
    // A new floor goes on top of its building.
    const args: CommandArgs['floor.assign'] = building === null ? { floor, building: null } : { floor, building, index: 0 };
    if (await this.run(`f:${floor}`, 'floor.assign', args, { floor: name })) {
      this.setStatus(building === null ? `Moved ${name} to the unassigned lot.` : `Moved ${name} to the top of ${buildingName}.`);
    }
    this.list?.querySelector<HTMLElement>(`[data-key="move:${CSS.escape(floor)}"]`)?.focus();
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
        const fs = store.stack(id).map((f) => f.name);
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
    const f = this.host.store.floorView(v.floor);
    if (!f) {
      this.close();
      this.host.toast(`${this.host.store.floorName(v.floor)} is gone.`, 'info');
      return;
    }
    const where = f.level ? `Floor ${f.level.number} of ${f.building?.name ?? ''}` : LOT;
    replaceKeepingFocus(this.head, this.headFor('Floor settings', `${f.name} · ${where}`, h('div', { class: 'lift-display', 'aria-hidden': 'true' }, icon(ICON.gear)), v.from));
    if (!first && this.settingsForm?.floor === v.floor) return;
    this.setSettingsForm(this.buildSettings(f));
    this.body.replaceChildren(this.settingsForm!.el);
  }

  /** The settings form on show (the old one's Kaneo pickers stop listening). */
  private setSettingsForm(f: Panels['settingsForm']): void {
    this.settingsForm?.dispose();
    this.settingsForm = f;
  }

  private buildSettings(f: FloorView): NonNullable<Panels['settingsForm']> {
    const floor = f.id;
    const kaneoBook = this.host.store.kaneo;
    const init = formFrom(f.settings, f.suggested, kaneoBook.state?.default_workspace?.id ?? null);
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
      const isDefault = init.statusDefault && statusName.value === d.name && v.length === d.options.length && v.every((o, i) => o.text === d.options[i]);
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
    // The default hire offers the models Settings leaves shown, and the saved default even when it is hidden.
    const prefs = this.host.modelPrefs;
    const hire = this.host.store.hireOptions;
    const offered = offeredOptions(hire, prefs && ((harness) => prefs.hidden(harness)), [{ harness: init.form.harness, model: init.form.model }]);
    const cwdHint = init.cwdPlaceholder ? `Empty uses the repo’s root checkout, ${init.cwdPlaceholder}.` : 'An absolute path on the server. Empty: the workers’ own folders.';

    const harness = select([['', 'No default'], ...Object.keys(offered).map((k): [string, string] => [k, k])], init.form.harness);
    const model = select([], '');
    const effort = select([], '');
    const fillModel = (keep: string) => {
      const models = offered[harness.value]?.models ?? [];
      const names = modelEntries(harness.value, models, labelsOf(offered, harness.value));
      model.replaceChildren(h('option', { value: '' }, harness.value ? 'Choose a model' : '—'), ...names.map((e) => h('option', { value: e.id, title: e.named ? e.id : null }, modelOptionText(e))));
      model.value = models.includes(keep) ? keep : '';
      model.disabled = !harness.value;
    };
    const fillEffort = (keep: string) => {
      const efforts = effortsFor(offered, harness.value, model.value);
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

    // #184: the issue tracker. GitHub (the repo's issues and Projects) or a Kaneo project; the other one's settings
    // stay as they were, so switching back finds them. The repo stays the floor's code either way.
    const picker = new KaneoPicker({ book: kaneoBook, send: (t, args) => this.host.send(t, args) }, f.settings.kaneo ?? null, init.form.kaneoWorkspace, init.form.kaneoProject, () => {
      clearError('kaneoWorkspace');
      clearError('kaneoProject');
    });
    let tracker = init.form.tracker;
    const trackerName = `set-tracker-${floor}`;
    const radio = (value: 'github' | 'kaneo', label: string, note: string) => {
      const input = h('input', { type: 'radio', name: trackerName, value, 'data-key': `tracker:${value}`, checked: tracker === value ? true : null });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        tracker = value;
        syncTracker();
      });
      return h('label', { class: 'tracker-opt' }, input, h('span', { class: 'tracker-name' }, label), h('span', { class: 'tracker-note' }, note));
    };
    const trackerGroup = h(
      'div',
      { class: 'tracker-pick', role: 'radiogroup', 'aria-label': 'Issue tracker' },
      radio('github', 'GitHub', 'Issues of the linked repo'),
      radio('kaneo', 'Kaneo', kaneoBook.connected ? 'A project of your Kaneo' : 'Connect it in Settings first'),
    );
    const repoNote = h('span', { class: 'legend-note' });
    const projectFieldset = h(
      'fieldset',
      {},
      h('legend', {}, 'GitHub Project ', h('span', { class: 'legend-note' }, 'optional · for the Issues and PRs boards')),
      h('div', { class: 'field-grid' }, field('projectOwner', 'Owner', owner, ''), field('projectNumber', 'Number', number, '')),
      statusGroup,
    );
    const syncTracker = () => {
      const kaneo = tracker === 'kaneo';
      picker.el.hidden = !kaneo;
      projectFieldset.hidden = kaneo;
      repoNote.textContent = kaneo ? 'optional · its pull requests and checkouts; the issues come from Kaneo' : '';
      if (kaneo) picker.activate();
    };
    syncTracker();

    const unsupported = this.host.unsupported('floor.settings.set');
    const save = h('button', { class: 'btn btn--primary', type: 'submit', 'aria-disabled': unsupported ? 'true' : null, title: unsupported ? failureText('floor.settings.set', 'unknown_command', '') : null }, 'Save settings');
    const cancel = h('button', { class: 'btn', onclick: () => (this.view?.kind === 'settings' && this.view.from ? this.show(this.view.from) : this.close()) }, 'Cancel');

    const form = h(
      'form',
      { class: 'settings', novalidate: true, 'aria-label': `Settings for ${f.name}` },
      h('fieldset', { class: 'tracker-set' }, h('legend', {}, 'Issue tracker'), trackerGroup, picker.el),
      h('fieldset', {}, h('legend', {}, 'Linked GitHub repo', repoNote), repoField),
      projectFieldset,
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
      tracker,
      kaneoWorkspace: picker.workspace,
      kaneoProject: picker.projectId,
    });
    const show = (errors: Partial<Record<FieldKey, string>>, badOption: number | null = null) => {
      picker.flag('kaneoWorkspace', errors.kaneoWorkspace ?? null);
      picker.flag('kaneoProject', errors.kaneoProject ?? null);
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
      if (k === 'kaneoWorkspace' || k === 'kaneoProject') return picker.flag(k, null);
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
      const cur = this.host.store.floorView(floor);
      if (!cur) return;
      const p = parseForm(read(), hire, cur.settings);
      show(p.errors, p.badOption);
      const bad = (Object.keys(p.errors) as FieldKey[])[0];
      if (bad) {
        if (bad === 'statusOptions') statuses.focus(p.badOption);
        else if (bad === 'kaneoWorkspace') picker.workspaceSelect.focus();
        else if (bad === 'kaneoProject') picker.projectSelect.focus();
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
      save.setAttribute('aria-busy', 'true');
      save.textContent = 'Saving…';
      this.setStatus('Saving…');
      void this.host.send('floor.settings.set', { floor, ...patch }).then((r) => {
        save.removeAttribute('aria-disabled');
        save.removeAttribute('aria-busy');
        save.textContent = 'Save settings';
        if (!r.ok) {
          this.setStatus(failureText('floor.settings.set', r.code, r.message, { floor: this.host.store.floorName(floor) }), 'error');
          if (r.code === 'unknown_command') {
            save.setAttribute('aria-disabled', 'true');
            save.title = failureText('floor.settings.set', 'unknown_command', '');
          }
          return;
        }
        // Rebuild from what is stored now: the suggestion mark goes, values normalise.
        const now = this.host.store.floorView(floor);
        if (now && this.view?.kind === 'settings' && this.view.floor === floor) {
          this.setSettingsForm(this.buildSettings(now));
          this.body.replaceChildren(this.settingsForm!.el);
          this.body.querySelector<HTMLElement>('.settings-actions .btn--primary')?.focus();
        }
        const names: Record<string, string> = { repo: 'repo', project: 'project', status_field: 'status field', default_cwd: 'default folder', default_hire: 'default hire', tracker: 'issue tracker', kaneo: 'Kaneo project' };
        this.setStatus(`Saved the ${Object.keys(patch).map((k) => names[k] ?? k).join(', ')}.`);
      });
    });
    return { el: form, read, floor, repoSuggested: init.repoSuggested, statusDefault: init.statusDefault, dispose: () => picker.dispose() };
  }

  /**
   * The status list: one input per status, in board order, with buttons to
   * move and remove each and to add one. A row per label keeps any label
   * intact (commas and all); rows persist, so typing, focus and the stored
   * label a row was opened with survive a move.
   */
  private statusEditor(
    initial: StatusRow[],
    hintId: string,
    changed: () => void,
  ): { el: HTMLElement; values(): StatusRow[]; flag(row: number | null): void; focus(row: number | null): void } {
    interface Row {
      stored: string | null;
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
    const make = ({ text, stored }: StatusRow): Row => {
      const id = seq++;
      const input = h('input', { 'data-key': `opt:${id}`, name: 'statusOptions', value: text, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': hintId });
      const r: Row = {
        stored,
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
      const r = make({ text: '', stored: null });
      rows.push(r);
      layout();
      r.input.focus();
      changed();
    });
    for (const t of initial) rows.push(make(t));
    layout();
    return {
      el: h('div', { class: 'opts-editor' }, list, add),
      values: () => rows.map((r) => ({ text: r.input.value, stored: r.stored })),
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
    if (v.kind === 'elevator') {
      const rows = this.rows(v.building);
      return { kind: 'elevator', building: v.building, title: this.elevatorTitle(v.building), rows, lobby: rows.length ? { current: this.host.inLobby() } : null, ...(this.pick ? { pick: this.pick.floor } : {}), ...base };
    }
    if (v.kind === 'buildings') {
      return {
        kind: 'buildings',
        buildings: store.sortedBuildings().map((b) => ({ id: b.id, name: b.name, floors: store.stack(b.id).map((f) => f.id), logo: logoHashOf(b), logoBusy: this.busy.get(`l:${b.id}`) ?? null })),
        lot: store.stack(null).map((f) => f.id),
        ...base,
      };
    }
    const sf = this.settingsForm;
    const form = sf ? sf.read() : formFrom({}, {}).form;
    return {
      kind: 'settings',
      floor: v.floor,
      form: { ...form, statusOptions: form.statusOptions.map((r) => r.text) },
      repoSuggested: sf?.repoSuggested ?? false,
      statusDefault: sf?.statusDefault ?? false,
      ...base,
    };
  }
}

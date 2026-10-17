import './schedules.css';
import type { CommandName, Schedule } from '../net/protocol';
import { HARNESS_LABEL } from '../world/hire';
import { inboxWhere } from '../world/inbox';
import { lateBy, lateText, onMissText, scheduleFailureText, scheduleSections, type ScheduleSections } from '../world/schedule';
import { countdownText, utcHint, whenText } from '../world/scheduleTime';
import { browserZone, civilAt } from '../world/daylight';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import type { DialogHost } from './hire';

/**
 * #64 schedules (part 3 of #61): the scheduled agents dialog. Three sections of the bridge's schedules (#62): Upcoming
 * (scheduled and waiting by due time, and the ones starting now), Needs attention (failed and skipped, until
 * dismissed) and Scheduled successfully (the last 50 that started, a badge when one started late, a way to the worker
 * it hired while it is still here). The floor you are on by default; All floors groups the rows by `Building › floor`.
 * Every action of #62 is here: Edit and "+ New" open the form (`ui/scheduleForm.ts`, the host's), Run now, Cancel
 * (after a confirm in its row), Retry, Dismiss. The list follows `schedule.upsert` / `schedule.removed` live and keeps
 * the focus and scroll; the countdowns tick only while it is open.
 */

export interface SchedulesHost extends DialogHost {
  /** "+ New": the form for a floor, with its defaults. */
  create(floor: string): void;
  /** Edit: the form for a scheduled one. */
  edit(s: Schedule): void;
  /** Sits you at a hired worker (false: it is gone). */
  goTo(workerId: string): void;
}

/** How the dialog opens: on a floor (default: the one you are on), on all floors, focused on one schedule. */
export interface SchedulesOpen {
  floor?: string | null;
  allFloors?: boolean;
  focus?: string;
}

/** One row as shown (test hook). */
export interface ScheduleRowSummary {
  id: string;
  title: string;
  state: string;
  floor: string;
  when: string;
  countdown: string;
  late: string | null;
  actions: string[];
}

/** What the dialog shows (test hook `window.__h3d.schedules()`). */
export interface SchedulesSummary {
  open: boolean;
  floor: string | null;
  allFloors: boolean;
  /** The `Building › floor` groups in order (All floors), else []. */
  groups: string[];
  upcoming: ScheduleRowSummary[];
  attention: ScheduleRowSummary[];
  done: ScheduleRowSummary[];
  empty: string | null;
  confirming: string | null;
  focus: string | null;
  status: string;
  error: boolean;
}

const CLOCK_ICON = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>';
const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type SectionKey = keyof ScheduleSections;
const SECTIONS: Array<{ key: SectionKey; title: string; empty: string }> = [
  { key: 'upcoming', title: 'Upcoming', empty: 'Nothing is scheduled.' },
  { key: 'attention', title: 'Needs attention', empty: 'Nothing needs you.' },
  { key: 'done', title: 'Scheduled successfully', empty: 'None has started yet.' },
];

export class SchedulesDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg sch', 'aria-labelledby': 'sch-title', 'aria-describedby': 'sch-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly body = h('div', { class: 'sch-body', 'data-hook': 'sch-body' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private floor: string | null = null;
  private allFloors = false;
  private focusId: string | null = null;
  private confirming: string | null = null;
  /** Schedules with a command on its way: their buttons wait. */
  private readonly busy = new Set<string>();
  private statusText = '';
  private statusError = false;
  private seenVersion = -1;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly zone = browserZone();

  constructor(
    parent: HTMLElement,
    private readonly host: SchedulesHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    this.dialog.append(this.head, this.body, h('footer', { class: 'dd-foot sch-foot' }, this.statusEl, this.alertEl));
    this.dialog.addEventListener('close', () => {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.confirming = null;
    });
    // Esc in a cancel confirm steps back; it does not close the dialog.
    this.dialog.addEventListener('cancel', (e) => {
      if (!this.confirming) return;
      e.preventDefault();
      const id = this.confirming;
      this.confirming = null;
      this.render();
      this.rowEl(id)?.querySelector<HTMLElement>('[data-act="cancel"]')?.focus();
    });
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Opens it (again: re-aims it). Outside a floor it opens on All floors; `focus` scrolls to that schedule and marks it. */
  open(o: SchedulesOpen = {}): void {
    const focus = o.focus ? this.host.store.schedules.get(o.focus) : undefined;
    this.floor = o.floor ?? focus?.floor ?? null;
    this.allFloors = o.allFloors ?? this.floor === null;
    // A focused row on another floor: that floor (unless all of them are shown).
    if (focus && !this.allFloors) this.floor = focus.floor;
    this.focusId = o.focus ?? null;
    this.confirming = null;
    this.setStatus('');
    this.seenVersion = this.host.store.schedules.version;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 1000);
    const row = this.focusId ? this.rowEl(this.focusId) : null;
    if (row) {
      row.scrollIntoView?.({ block: 'center' });
      row.focus();
    } else this.dialog.querySelector<HTMLElement>('[data-key="new"]')?.focus();
  }

  /** A schedule just saved from the form: its row marked and focused (its floor's, or all floors as shown now). */
  reveal(id: string): void {
    if (!this.dialog.open) return;
    const s = this.host.store.schedules.get(id);
    if (s && !this.allFloors && s.floor !== this.floor) this.floor = s.floor;
    this.focusId = id;
    this.seenVersion = this.host.store.schedules.version;
    this.render();
    const row = this.rowEl(id);
    row?.scrollIntoView?.({ block: 'center' });
    row?.focus();
  }

  /** The world changed: an upsert or a removal re-draws the list, keeping the focus and the scroll. */
  refresh(): void {
    if (!this.dialog.open) return;
    const v = this.host.store.schedules.version;
    if (v === this.seenVersion) return;
    this.seenVersion = v;
    if (this.confirming && !this.cancellable(this.host.store.schedules.get(this.confirming))) this.confirming = null;
    this.render();
  }

  private cancellable(s: Schedule | undefined): boolean {
    return !!s && (s.state === 'scheduled' || s.state === 'waiting');
  }

  /** The schedules in view, by group (`Building › floor`, All floors) or the floor's alone. */
  private groups(): Array<{ floor: string; where: string; sections: ScheduleSections }> {
    const all = this.host.store.schedules.all();
    if (!this.allFloors) return this.floor ? [{ floor: this.floor, where: inboxWhere(this.host.store, this.floor), sections: scheduleSections(all.filter((s) => s.floor === this.floor)) }] : [];
    // The city's order (building by building), then floors the store no longer has.
    const order = this.host.store.city().flatMap((b) => b.floors.map((f) => f.id));
    const floors = [...new Set(all.map((s) => s.floor))].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || (a < b ? -1 : 1);
    });
    // Each floor's own sections, so one busy floor's done rows never push out another's.
    return floors.map((f) => ({ floor: f, where: inboxWhere(this.host.store, f), sections: scheduleSections(all.filter((s) => s.floor === f)) }));
  }

  private render(): void {
    const known = this.host.store.schedules.known;
    const groups = this.groups();
    const count = (k: SectionKey) => groups.reduce((n, g) => n + g.sections[k].length, 0);
    const where = this.allFloors ? 'All floors' : this.floor ? this.host.store.floorName(this.floor) : '';
    const counts = [`${count('upcoming')} upcoming`, count('attention') ? `${count('attention')} need${count('attention') === 1 ? 's' : ''} attention` : ''].filter(Boolean).join(', ');
    const newFloor = this.floor;
    const off = !known || this.host.unsupported('schedule.create');
    this.head.replaceChildren(
      h('div', { class: 'dd-plate sch-plate', 'aria-hidden': 'true' }, icon(CLOCK_ICON)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'sch-title' }, 'Scheduled agents'), h('p', { id: 'sch-sub' }, known ? `${where} · ${counts}` : where)),
      h(
        'button',
        {
          class: 'btn btn--sm',
          'data-key': 'all-floors',
          'aria-pressed': this.allFloors ? 'true' : 'false',
          disabled: !this.floor,
          title: this.floor ? 'Show the schedules of every floor, grouped by building and floor' : 'Outside a floor every floor is shown',
          onclick: () => this.toggleAll(),
        },
        'All floors',
      ),
      h(
        'button',
        {
          class: 'btn btn--sm btn--primary',
          'data-key': 'new',
          'aria-disabled': off || !newFloor ? 'true' : null,
          title: off ? 'This herdr-world can’t schedule agents yet.' : newFloor ? `Schedule an agent on ${this.host.store.floorName(newFloor)}` : 'Go to a floor to schedule an agent there',
          onclick: () => {
            if (!off && newFloor) this.host.create(newFloor);
            else this.setStatus(off ? 'This herdr-world can’t schedule agents yet: it is older than scheduled agents.' : 'Schedules belong to a floor: open this on a floor, or from a floor’s row of the palette.', true);
          },
        },
        icon(ICON.plus),
        'New',
      ),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );

    const nodes: Node[] = [];
    const empty = this.emptyText(known, groups);
    if (empty) nodes.push(h('div', { class: 'sch-empty', 'data-hook': 'sch-empty' }, h('p', {}, empty.title), empty.hint ? h('p', { class: 'sch-empty-hint' }, empty.hint) : null));
    else
      for (const sec of SECTIONS) {
        const rows: Node[] = [];
        for (const g of groups) {
          const list = g.sections[sec.key];
          if (!list.length) continue;
          if (this.allFloors) rows.push(h('li', { class: 'sch-group', 'data-floor': g.floor }, g.where));
          for (const s of list) rows.push(this.row(s, sec.key));
        }
        const n = count(sec.key);
        nodes.push(
          h(
            'section',
            { class: 'sch-sec', 'data-sec': sec.key, 'aria-labelledby': `sch-sec-${sec.key}` },
            h('h3', { id: `sch-sec-${sec.key}`, class: 'sch-sec-title' }, sec.title, h('span', { class: 'sch-count' }, String(n))),
            rows.length ? h('ol', { class: 'sch-list' }, ...rows) : h('p', { class: 'sch-sec-empty' }, sec.empty),
          ),
        );
      }
    replaceKeepingFocus(this.body, nodes, 'new', { keepScroll: true });
  }

  private emptyText(known: boolean, groups: ReturnType<SchedulesDialog['groups']>): { title: string; hint: string | null } | null {
    if (!known) return { title: 'This herdr-world can’t schedule agents yet.', hint: 'It is older than scheduled agents: update herdr-world to schedule one.' };
    if (groups.some((g) => g.sections.upcoming.length || g.sections.attention.length || g.sections.done.length)) return null;
    const where = this.allFloors ? 'on any floor' : `on ${this.floor ? this.host.store.floorName(this.floor) : 'this floor'}`;
    return { title: `No scheduled agents ${where}.`, hint: '“New” schedules one for later. Under a worker’s last reply, “Schedule follow-up…” starts one from it.' };
  }

  private row(s: Schedule, sec: SectionKey): HTMLElement {
    const now = this.host.now();
    const at = sec === 'done' && typeof s.fired_at === 'number' ? s.fired_at : s.due_at;
    const c = civilAt(at, this.zone);
    const late = sec === 'done' ? lateBy(s) : null;
    const busy = this.busy.has(s.id);
    const stamp = h('div', { class: 'sch-stamp', title: `${whenText(at, this.zone)} · ${utcHint(at, this.zone)}` }, h('b', {}, `${pad(c.hour)}:${pad(c.minute)}`), h('span', {}, `${WEEKDAY[c.weekday]} ${c.day} ${MONTH[c.month - 1]}`));

    const lead: Node[] = [];
    if (sec === 'upcoming') {
      if (s.state === 'running') lead.push(h('span', { class: 'tape tape--working' }, 'Starting'));
      if (s.state === 'waiting') lead.push(h('span', { class: 'tape tape--waiting' }, 'Waiting'));
      lead.push(h('span', { class: 'sch-countdown', 'data-due': String(s.due_at), 'aria-live': 'off' }, s.state === 'running' ? 'starting now' : countdownText(s.due_at, now)));
      lead.push(h('span', { class: 'sch-utc' }, utcHint(s.due_at, this.zone)));
    } else if (sec === 'attention') {
      lead.push(h('span', { class: `tape ${s.state === 'failed' ? 'tape--failed' : 'tape--skipped'}` }, s.state === 'failed' ? 'Failed' : 'Skipped'));
      lead.push(h('span', { class: 'sch-utc' }, `due ${utcHint(s.due_at, this.zone)}`));
    } else {
      lead.push(h('span', { class: 'sch-started' }, 'Started'));
      lead.push(h('span', { class: 'sch-utc' }, utcHint(at, this.zone)));
      if (late !== null) lead.push(h('span', { class: 'sch-late', title: `Due ${whenText(s.due_at, this.zone)}` }, lateText(late)));
    }

    const reason = (s.state === 'waiting' || sec === 'attention') && s.state_reason ? h('p', { class: 'sch-reason', 'data-hook': 'sch-reason' }, s.state_reason) : null;
    const meta = h(
      'p',
      { class: 'sch-meta' },
      h('span', {}, [HARNESS_LABEL[s.harness] ?? s.harness, s.model, s.effort].filter(Boolean).join(' · ')),
      h('code', { class: 'sch-cwd', title: s.cwd }, s.cwd),
      s.worktree ? h('span', {}, 'own worktree') : null,
      s.handoff_path ? h('span', { class: 'sch-handoff', title: s.handoff_path, 'data-hook': 'sch-handoff' }, icon(ICON.folder), 'Handoff') : null,
      sec === 'upcoming' ? h('span', { 'data-hook': 'sch-miss' }, onMissText(s)) : null,
      sec === 'upcoming' && !s.wake_floor ? h('span', {}, 'won’t wake the floor') : null,
    );

    // Keys name the row too, so a live re-draw puts the focus back on this row's button, not the first of its kind.
    const act = (key: string, label: string, run: () => void, cls = 'btn btn--sm') => h('button', { class: cls, 'data-key': `${key}:${s.id}`, 'data-act': key, disabled: busy, onclick: run }, label);
    const actions: HTMLElement[] = [];
    if (sec === 'upcoming' && s.state === 'scheduled') {
      actions.push(act('edit', 'Edit', () => this.host.edit(s)));
      actions.push(act('run-now', 'Run now', () => void this.command('schedule.run_now', s, `“${s.title}” is starting now.`)));
    }
    if (sec === 'upcoming' && this.cancellable(s)) actions.push(act('cancel', 'Cancel', () => this.confirmCancel(s.id), 'btn btn--sm btn--danger-quiet'));
    if (sec === 'attention') {
      actions.push(act('retry', 'Retry', () => void this.command('schedule.retry', s, `“${s.title}” is starting again.`)));
      actions.push(act('dismiss', 'Dismiss', () => void this.command('schedule.dismiss', s, `Dismissed “${s.title}”.`)));
    }
    if (sec === 'done' && s.worker_id && this.host.store.workers.has(s.worker_id)) {
      const id = s.worker_id;
      const name = this.host.store.workerView(id)?.name ?? 'the worker';
      actions.push(act('go', `Go to ${name}`, () => {
        this.close();
        this.host.goTo(id);
      }));
    }

    const confirm =
      this.confirming === s.id
        ? h(
            'div',
            { class: 'sch-confirm', role: 'group', 'aria-labelledby': `sch-confirm-${s.id}` },
            h('p', { id: `sch-confirm-${s.id}` }, `Cancel “${s.title}”? It will not start, and it leaves this list.`),
            h(
              'div',
              { class: 'sch-actions' },
              h('button', { class: 'btn btn--sm', 'data-key': `keep:${s.id}`, 'data-act': 'keep', onclick: () => this.stepBack(s.id) }, 'Keep it'),
              h('button', { class: 'btn btn--sm btn--danger', 'data-key': `confirm-cancel:${s.id}`, 'data-act': 'confirm-cancel', disabled: busy, onclick: () => void this.command('schedule.cancel', s, `Cancelled “${s.title}”.`) }, 'Cancel schedule'),
            ),
          )
        : null;

    return h(
      'li',
      { class: 'sch-row', 'data-id': s.id, 'data-state': s.state, 'data-focus': this.focusId === s.id ? 'true' : null, tabindex: '-1', 'aria-labelledby': `sch-t-${s.id}` },
      stamp,
      h('div', { class: 'sch-main' }, h('p', { class: 'sch-title', id: `sch-t-${s.id}` }, s.title), h('p', { class: 'sch-lead' }, ...lead), reason, meta, confirm),
      actions.length && !confirm ? h('div', { class: 'sch-actions' }, ...actions) : null,
    );
  }

  private rowEl(id: string): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(`.sch-row[data-id="${CSS.escape(id)}"]`);
  }

  private toggleAll(): void {
    if (!this.floor) return;
    this.allFloors = !this.allFloors;
    this.confirming = null;
    this.render();
    this.dialog.querySelector<HTMLElement>('[data-key="all-floors"]')?.focus();
  }

  private confirmCancel(id: string): void {
    this.confirming = id;
    this.render();
    this.rowEl(id)?.querySelector<HTMLElement>('[data-act="keep"]')?.focus();
  }

  private stepBack(id: string): void {
    this.confirming = null;
    this.render();
    this.rowEl(id)?.querySelector<HTMLElement>('[data-act="cancel"]')?.focus();
  }

  private async command(t: CommandName & `schedule.${string}`, s: Schedule, done: string): Promise<void> {
    if (this.busy.has(s.id)) return;
    this.busy.add(s.id);
    this.render();
    const r = await this.host.send(t, { id: s.id } as never);
    this.busy.delete(s.id);
    if (t === 'schedule.cancel') this.confirming = null;
    if (!this.dialog.open) return;
    if (r.ok) this.setStatus(done);
    else this.setStatus(scheduleFailureText(t, r.code, r.message, s.title), true);
    this.render();
    // The focus stays in the list: on the row if it is still there, else the dialog's first control.
    if (!this.dialog.contains(document.activeElement)) (this.rowEl(s.id) ?? this.dialog.querySelector<HTMLElement>('[data-key="new"]'))?.focus();
  }

  /** The countdowns move on in place (no re-render: focus, selection and scroll stay). */
  private tick(): void {
    if (!this.dialog.open) return;
    const now = this.host.now();
    for (const el of this.body.querySelectorAll<HTMLElement>('.sch-countdown[data-due]')) {
      if (el.closest('.sch-row')?.getAttribute('data-state') === 'running') continue;
      const t = countdownText(Number(el.dataset.due), now);
      if (el.textContent !== t) el.textContent = t;
    }
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  summary(): SchedulesSummary {
    const rows = (sec: SectionKey) =>
      [...this.body.querySelectorAll<HTMLElement>(`.sch-sec[data-sec="${sec}"] .sch-row`)].map((r) => ({
        id: r.dataset.id ?? '',
        title: r.querySelector('.sch-title')?.textContent ?? '',
        state: r.dataset.state ?? '',
        floor: this.host.store.schedules.get(r.dataset.id ?? '')?.floor ?? '',
        when: r.querySelector('.sch-stamp')?.getAttribute('title') ?? '',
        countdown: r.querySelector('.sch-countdown')?.textContent ?? '',
        late: r.querySelector('.sch-late')?.textContent ?? null,
        actions: [...r.querySelectorAll<HTMLElement>('button[data-act]')].map((b) => b.dataset.act ?? ''),
      }));
    return {
      open: this.dialog.open,
      floor: this.floor,
      allFloors: this.allFloors,
      groups: [...new Set([...this.body.querySelectorAll<HTMLElement>('.sch-group')].map((g) => g.textContent ?? ''))],
      upcoming: rows('upcoming'),
      attention: rows('attention'),
      done: rows('done'),
      empty: this.body.querySelector('[data-hook="sch-empty"] p')?.textContent ?? null,
      confirming: this.confirming,
      focus: this.focusId,
      status: this.statusText,
      error: this.statusError,
    };
  }
}

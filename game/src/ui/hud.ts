import type { ConnState } from '../net/client';
import { modelLabel, STATUS_WORD, taskLine, type Display } from '../world/derive';
import type { Counts, FloorView, WorkerView } from '../world/store';
import type { Target } from '../render/office';
import { CHIP_TEXT } from '../world/derive';
import { ICON as DOM_ICON } from './dom';

/** Authored 24×24 stroke icons, one weight. */
const ICON = {
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  issues: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  prs: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5 10.5 7l2 2"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19 13 11"/>',
  building: DOM_ICON.building,
};
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const KEYS: Array<[string, string]> = [
  ['E', 'Laptop'],
  ['C', 'Changes'],
  ['P', 'Prompt'],
  ['H', 'Handoff'],
  ['X', 'Send home'],
];

export type HudAction = 'city' | 'issues' | 'prs' | 'battery' | 'buildings';

export interface PlanLabel {
  x: number;
  y: number;
  text: string;
  kind: 'prop' | 'worker' | 'desk';
  display?: Display;
}

/** All DOM UI over the canvas. Pure presentation: the app feeds it state. */
export class Hud {
  readonly root: HTMLDivElement;
  /** Static, screen-reader and keyboard list of floors (the badges are drawn in the scene). */
  readonly floorList: HTMLElement;
  /** Same for buildings: each opens its elevator panel (M3). */
  readonly buildingList: HTMLElement;
  private readonly name = el('div', 'topbar-name');
  private readonly sub = el('div', 'topbar-sub');
  private readonly counts = el('div', 'topbar-counts');
  private readonly back = el('button', 'btn btn--back', `${svg(ICON.back)}<span>City</span>`);
  private readonly issues = el('button', 'btn', `${svg(ICON.issues)}<span>Issues</span>`);
  private readonly prs = el('button', 'btn', `${svg(ICON.prs)}<span>PRs</span>`);
  private readonly battery = el('button', 'btn btn--icon', svg(ICON.leaf));
  private readonly buildings = el('button', 'btn', `${svg(ICON.building)}<span>Buildings</span>`);
  private readonly conn = el('span', 'conn', '<i></i><span></span>');
  private readonly reticle = el('div', 'reticle');
  private readonly prompt = el('div', 'prompt');
  private readonly hint = el('div', 'hint');
  private readonly plan = el('div', 'plan');
  private readonly planCard = el('div', 'plan-card');
  private readonly planLabels = el('div');
  private readonly you = el('div', 'plan-you', svg('<path d="M12 3 19 20 12 16 5 20z" fill="#ffc233" stroke="#1c2540"/>'));
  private readonly notice = el('div', 'notice');
  private readonly toastEl = el('div', 'toast');
  private readonly doors = el('div', 'doors', '<div class="door"></div><div class="door"></div><div class="doors-label"></div>');
  private readonly dialog = el('dialog', 'sheet');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Map<HudAction, Array<() => void>>();
  private promptKey = '';
  private mode: 'city' | 'floor' = 'city';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.floorList = el('nav', 'floor-list');
    this.floorList.setAttribute('aria-label', 'Floors');
    this.buildingList = el('nav', 'building-list');
    this.buildingList.setAttribute('aria-label', 'Buildings');
    const bar = el('header', 'topbar');
    const place = el('div', 'topbar-place');
    const title = el('div', 'topbar-title');
    title.append(this.name, this.sub);
    place.append(this.back, title);
    const actions = el('div', 'topbar-actions');
    this.battery.title = 'Battery saver: lower frame rates (B)';
    this.battery.setAttribute('aria-pressed', 'false');
    this.battery.setAttribute('aria-label', 'Battery saver');
    this.issues.title = 'Issues board overlay (arrives in M7)';
    this.prs.title = 'Pull requests overlay (arrives in M7)';
    this.back.title = 'Back to the city (Backspace)';
    this.buildings.title = 'Buildings: create, rename and arrange buildings and floors (M)';
    actions.append(this.buildings, this.issues, this.prs, this.battery, this.conn);
    bar.append(place, this.counts, actions);
    new ResizeObserver(() => this.root.style.setProperty('--topbar-bottom', `${bar.getBoundingClientRect().bottom.toFixed(1)}px`)).observe(bar);
    for (const [b, a] of [
      [this.back, 'city'],
      [this.issues, 'issues'],
      [this.prs, 'prs'],
      [this.battery, 'battery'],
      [this.buildings, 'buildings'],
    ] as const) {
      b.type = 'button';
      b.addEventListener('click', () => this.emit(a));
    }
    this.prompt.hidden = true;
    this.prompt.setAttribute('role', 'status');
    this.plan.hidden = true;
    this.plan.append(this.planLabels, this.you, this.planCard);
    this.notice.hidden = true;
    this.toastEl.hidden = true;
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    this.root.append(this.floorList, this.buildingList, this.plan, bar, this.reticle, this.prompt, this.hint, this.notice, this.toastEl, this.doors);
    parent.append(this.root, this.dialog);
    this.setMode('city');
  }

  on(a: HudAction, fn: () => void): void {
    this.listeners.set(a, [...(this.listeners.get(a) ?? []), fn]);
  }

  private emit(a: HudAction): void {
    for (const fn of this.listeners.get(a) ?? []) fn();
  }

  setMode(mode: 'city' | 'floor'): void {
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.back.hidden = mode === 'city';
    this.issues.hidden = this.prs.hidden = mode === 'city';
    this.buildings.hidden = mode !== 'city';
    this.reticle.hidden = mode === 'city';
    this.floorList.hidden = this.buildingList.hidden = mode !== 'city';
    if (mode === 'city') {
      this.setTarget(null, null);
      this.setPlan(false, '');
    }
  }

  setBattery(on: boolean): void {
    this.battery.setAttribute('aria-pressed', String(on));
  }

  setConn(s: ConnState, fixture: boolean, now: number): void {
    const span = this.conn.querySelector('span');
    let text = '';
    switch (s.phase) {
      case 'live':
        text = fixture ? 'Fixture' : 'Live';
        break;
      case 'connecting':
        text = 'Connecting…';
        break;
      case 'waiting':
        text = `Retrying in ${Math.max(1, Math.ceil((s.retryAt - now) / 1000))} s`;
        break;
      case 'failed':
        text = 'Bridge refused';
        break;
      case 'stopped':
        text = 'Offline';
        break;
    }
    this.conn.dataset.phase = s.phase;
    this.conn.title = s.phase === 'waiting' || s.phase === 'failed' ? s.reason : '';
    if (span && span.textContent !== text) span.textContent = text;
  }

  private setCounts(c: Counts, asleep = false): void {
    if (asleep) {
      this.counts.innerHTML = `<span class="count count--asleep"><i></i><b>${c.total}</b><span>asleep</span></span>`;
      return;
    }
    const item = (cls: string, n: number, label: string) => `<span class="count count--${cls}"><i></i><b>${n}</b><span>${label}</span></span>`;
    this.counts.innerHTML = item('working', c.working, 'working') + item('needs_you', c.needsYou, 'needs you') + item('idle', c.idle, 'idle');
  }

  setCity(buildings: number, floors: number, c: Counts): void {
    this.name.textContent = 'City';
    this.sub.textContent = `${buildings} ${buildings === 1 ? 'building' : 'buildings'} · ${floors} ${floors === 1 ? 'floor' : 'floors'}`;
    this.setCounts(c);
  }

  setFloor(v: FloorView): void {
    this.name.textContent = v.session;
    const where = v.level ? `Floor ${v.level.number} of ${v.level.count} · ${v.building?.name ?? ''}` : 'Unassigned lot';
    const state = v.transition === 'waking' ? ' · waking up…' : v.transition === 'sleeping' ? ' · going to sleep…' : v.asleep ? ' · asleep' : '';
    this.sub.textContent = where + state;
    this.setCounts(v.counts, v.asleep);
  }

  /** The look-at prompt bar. */
  setTarget(t: Target | null, w: WorkerView | null): void {
    // Everything the prompt shows for a worker, so a harness/effort-only upsert redraws it too.
    const shown = w ? [w.name, w.display, taskLine(w.worker), modelLabel(w.harness, w.worker.model, w.worker.effort)] : [];
    const key = t ? JSON.stringify([t.kind, t.id, ...shown]) : '';
    if (key === this.promptKey) return;
    this.promptKey = key;
    this.reticle.classList.toggle('is-target', !!t);
    if (!t) {
      this.prompt.hidden = true;
      return;
    }
    const line = el('div', 'prompt-line');
    const keys = el('div', 'prompt-keys');
    const disabled = (k: string, label: string, why: string) => {
      const s = el('span', 'key');
      s.setAttribute('aria-disabled', 'true');
      s.title = why;
      s.append(el('kbd', '', k), document.createTextNode(label));
      return s;
    };
    const text = (cls: string, s: string) => {
      const e = el('span', cls);
      e.textContent = s;
      return e;
    };
    if (t.kind === 'worker' && w) {
      const tape = text(`tape tape--${w.display}`, CHIP_TEXT[w.display]);
      line.append(text('prompt-name', w.name), tape, text('prompt-task', taskLine(w.worker)));
      const model = modelLabel(w.harness, w.worker.model, w.worker.effort);
      if (model) line.append(text('prompt-model', model));
      for (const [k, label] of KEYS) keys.append(disabled(k, label, 'Not wired up yet'));
      this.prompt.setAttribute('aria-label', `${w.name} · ${STATUS_WORD[w.display]} · ${taskLine(w.worker)}${model ? ` · ${model}` : ''}`);
    } else if (t.kind === 'desk') {
      line.append(text('prompt-name', t.label), text('prompt-task', 'Empty desk'));
      keys.append(disabled('E', 'Hire', 'Hiring arrives in M4'));
      this.prompt.setAttribute('aria-label', `${t.label} · E Hire`);
    } else if (t.kind === 'prop' && t.id === 'elevator') {
      line.append(text('prompt-name', 'Elevator'), text('prompt-task', 'Ride to another floor, wake one up or put it to sleep'));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Elevator'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', 'Elevator · E Elevator');
    } else if (t.kind === 'board' || t.kind === 'prop') {
      line.append(text('prompt-name', t.label), text('prompt-task', `Placeholder until ${t.milestone}`));
      keys.append(disabled('E', 'Open', `Arrives in ${t.milestone}`));
      this.prompt.setAttribute('aria-label', t.label);
    }
    this.prompt.replaceChildren(line, keys);
    this.prompt.hidden = false;
  }

  /** Bottom hint: what the controls do right now. */
  setHint(html: string | null): void {
    this.hint.hidden = !html;
    if (html && this.hint.innerHTML !== html) this.hint.innerHTML = html;
  }

  setPlan(open: boolean, title: string): void {
    this.plan.hidden = !open;
    this.reticle.hidden = open || this.mode === 'city';
    if (!open) return;
    const legend = (['working', 'needs_you', 'done', 'idle'] as const)
      .map((d) => `<span class="count count--${d}"><i></i><span style="color:inherit">${STATUS_WORD[d]}</span></span>`)
      .join('');
    this.planCard.innerHTML = `<h2></h2><p>Click the floor to walk there. <b>Tab</b> closes the plan. <b>Shift+Tab</b> reaches the top bar.</p><div class="plan-legend">${legend}<span class="count"><i style="background:var(--plus)"></i><span style="color:inherit">free desk</span></span></div>`;
    const h = this.planCard.querySelector('h2');
    if (h) h.textContent = `Floor plan · ${title}`;
  }

  /** Keyboard route into the top bar: focuses its first visible control. */
  focusTopbar(): void {
    const first = [this.back, this.buildings, this.issues, this.prs, this.battery].find((b) => !b.hidden);
    first?.focus();
  }

  get planElement(): HTMLDivElement {
    return this.plan;
  }

  setPlanLabels(labels: PlanLabel[], you: { x: number; y: number; angle: number }): void {
    const nodes: HTMLElement[] = labels.map((l) => {
      const e = el('div', `plan-label plan-label--${l.kind}`);
      e.style.left = `${l.x.toFixed(1)}px`;
      e.style.top = `${l.y.toFixed(1)}px`;
      if (l.kind === 'worker') {
        const dot = el('i');
        dot.style.setProperty('--c', `var(--${l.display ?? 'idle'})`);
        e.append(dot, document.createTextNode(l.text));
      } else e.textContent = l.text;
      return e;
    });
    this.planLabels.replaceChildren(...nodes);
    this.you.style.transform = `translate3d(${you.x.toFixed(1)}px,${you.y.toFixed(1)}px,0) rotate(${you.angle.toFixed(3)}rad)`;
  }

  /** Centre notice (empty / offline states); null hides it. */
  setNotice(title: string | null, body = ''): void {
    this.notice.hidden = !title;
    if (!title) return;
    const h = el('h2');
    h.textContent = title;
    const p = el('p');
    p.innerHTML = body;
    this.notice.replaceChildren(h, p);
  }

  toast(msg: string, ms = 3200, kind: 'info' | 'error' = 'info'): void {
    this.toastEl.textContent = msg;
    this.toastEl.dataset.kind = kind;
    this.toastEl.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), ms);
  }

  sheet(title: string, body: string): void {
    const box = el('div', 'sheet-body');
    const h = el('h2');
    h.textContent = title;
    const p = el('p');
    p.textContent = body;
    const actions = el('div', 'sheet-actions');
    const close = el('button', 'btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.dialog.close());
    actions.append(close);
    box.append(h, p, actions);
    this.dialog.replaceChildren(box);
    this.dialog.showModal();
    close.focus();
  }

  get sheetOpen(): boolean {
    return this.dialog.open;
  }

  /** Elevator doors close, `swap` runs, doors open. */
  async doorsTransition(label: string, swap: () => Promise<void> | void): Promise<void> {
    const lab = this.doors.querySelector('.doors-label');
    if (lab) lab.textContent = label;
    this.doors.classList.add('is-closed');
    await new Promise((r) => setTimeout(r, 280));
    await swap();
    await new Promise((r) => setTimeout(r, 140));
    this.doors.classList.remove('is-closed');
    await new Promise((r) => setTimeout(r, 280));
  }
}

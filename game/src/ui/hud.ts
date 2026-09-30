import type { ConnState } from '../net/client';
import { modelLabel, STATUS_WORD, taskLine, type Display } from '../world/derive';
import type { Counts, FloorView, WorkerView } from '../world/store';
import type { Target } from '../render/office';
import type { Area } from '../world/building';
import { CHIP_TEXT } from '../world/derive';
import { ICON as DOM_ICON } from './dom';
import { mountAudioControls } from './audioControls';
import { AboutDialog } from './about';
import type { LimitsPrefs } from './limitsPrefs';
import { MusicCredits } from './credits';
import type { BuildInfo } from '../version';
import { answerKeyEls, promptBarAria, promptBarKey, usageChip, askChip } from './promptBar';
// M6 crew: role, run, issue and report on the bar.
import { crewBarKey, crewLine } from './crewBar';
import { usageTotal, type UsageTotal } from '../world/usage';
import type { GameAudio } from '../audio';
import { backdropPolicy } from './dismiss';

/** Authored 24×24 stroke icons, one weight. */
const ICON = {
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  issues: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  prs: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5 10.5 7l2 2"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5.2M12 7.9v.1"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19 13 11"/>',
  building: DOM_ICON.building,
  lift: DOM_ICON.lift,
  stairs: '<path d="M4 19h4.5v-4.5H13V10h4.5V5.5H20"/>',
  door: '<path d="M6.5 20V5.2c0-.7.5-1.2 1.2-1.2h8.6c.7 0 1.2.5 1.2 1.2V20M4 20h16"/><circle cx="14.4" cy="12.4" r="1.1" fill="currentColor" stroke="none"/>',
  street: '<path d="M5 20 9.5 4M19 20 14.5 4M12 5.5v2M12 10.5v2.5M12 16.5v3"/>',
  hire: '<circle cx="9.5" cy="8" r="3.2"/><path d="M3.8 19.5c.6-3.4 2.8-5.3 5.7-5.3 1.4 0 2.6.4 3.6 1.2"/><path d="M18 13.5v6M15 16.5h6"/>',
};

/** Where you are outside a floor: the words and glyph in the top bar. */
const WHERE: Record<Exclude<Area, 'floor'>, { label: string; icon: string }> = {
  lobby: { label: 'Lobby', icon: ICON.door },
  street: { label: 'Outside', icon: ICON.street },
  'fire-escape': { label: 'Fire escape', icon: ICON.stairs },
};
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** Keys on a worker; `live` ones work (M4: X sends it home; M5: C changes, P prompt), the rest arrive later. */
const KEYS: Array<[string, string, boolean]> = [
  ['E', 'Laptop', false],
  ['C', 'Changes', true],
  ['P', 'Prompt', true],
  ['H', 'Handoff', false],
  ['X', 'Send home', true],
];

export type HudAction = 'city' | 'issues' | 'prs' | 'battery' | 'buildings' | 'elevator' | 'hire';

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
  /** M5: the floor's usage estimate (`≈$1.23`, `*` when an unknown model is in it). */
  private readonly usageEl = el('span', 'topbar-usage');
  private readonly back = el('button', 'btn btn--back', `${svg(ICON.back)}<span>City</span>`);
  private readonly issues = el('button', 'btn', `${svg(ICON.issues)}<span>Issues</span>`);
  private readonly prs = el('button', 'btn', `${svg(ICON.prs)}<span>PRs</span>`);
  private readonly battery = el('button', 'btn btn--icon', svg(ICON.leaf));
  private readonly about = el('button', 'btn btn--icon', svg(ICON.info));
  private readonly buildings = el('button', 'btn', `${svg(ICON.building)}<span>Buildings</span>`);
  /** On a floor: its building's elevator panel, for keyboards and when the elevator is out of sight. */
  private readonly elevator = el('button', 'btn', `${svg(ICON.lift)}<span>Elevator</span>`);
  /** M4: on a floor, hire at its first free desk. */
  private readonly hire = el('button', 'btn btn--hire', `${svg(ICON.hire)}<span>Hire</span>`);
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
  private toastSoft = false;
  private listeners = new Map<HudAction, Array<() => void>>();
  private promptKey = '';
  /** M15: what the radio is tuned to, for its look-at bar (the last target, to redraw it when this changes). */
  private radioName = 'Melodic house';
  private lastTarget: Target | null = null;
  private lastWorker: WorkerView | null = null;
  private mode: 'city' | 'floor' = 'city';
  /** M5: worker keys shown other than KEYS says (live, or disabled and why); see setKeyState. */
  private readonly keyStates = new Map<string, { live: boolean; why?: string }>();

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
    this.about.title = 'About: game, helper and bridge versions';
    this.about.setAttribute('aria-label', 'About');
    this.about.setAttribute('aria-haspopup', 'dialog');
    this.about.type = 'button';
    this.issues.title = 'Issues: this floor’s board as a list';
    this.prs.title = 'Pull requests: this floor’s open pull requests as a list';
    this.back.title = 'Back to the city (Backspace)';
    this.buildings.title = 'Buildings: create, rename and arrange buildings and floors (M)';
    this.elevator.title = 'Elevator: ride to another floor, wake or sleep floors, floor settings (L)';
    this.hire.title = 'Hire a worker at the first free desk on this floor (or look at a desk’s + and press E)';
    actions.append(this.buildings, this.issues, this.prs, this.elevator, this.hire, this.about, this.battery, this.conn);
    bar.append(place, this.counts, actions);
    this.counts.after(this.usageEl);
    this.usageEl.hidden = true;
    new ResizeObserver(() => this.root.style.setProperty('--topbar-bottom', `${bar.getBoundingClientRect().bottom.toFixed(1)}px`)).observe(bar);
    for (const [b, a] of [
      [this.back, 'city'],
      [this.issues, 'issues'],
      [this.prs, 'prs'],
      [this.battery, 'battery'],
      [this.buildings, 'buildings'],
      [this.elevator, 'elevator'],
      [this.hire, 'hire'],
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
    // A read-only sheet: the backdrop closes it only when the press and the click both began there (#51).
    backdropPolicy(this.dialog, 'sheet', () => this.dialog.close());
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
    this.elevator.hidden = mode === 'city';
    this.hire.hidden = mode === 'city' || this.root.dataset.area !== 'floor';
    this.syncExtras();
    this.reticle.hidden = mode === 'city';
    this.floorList.hidden = this.buildingList.hidden = mode !== 'city';
    if (mode === 'city') {
      this.setTarget(null, null);
      this.setPlan(false, '');
    }
  }

  /** The About panel (build versions), opened from the top bar's info button. */
  mountAbout(info: BuildInfo, limits?: LimitsPrefs): { dispose(): void } {
    const about = new AboutDialog(this.root.parentElement ?? this.root, info, limits);
    const open = () => about.open(this.about);
    this.about.addEventListener('click', open);
    return {
      dispose() {
        about.dispose();
      },
    };
  }

  /** M3b: the sound control (mute + volume) in the top bar, before the battery toggle. */
  mountAudio(audio: GameAudio): { dispose(): void } {
    // M15: the Music credits panel, opened from the sound control.
    const credits = new MusicCredits(this.root.parentElement ?? this.root);
    const controls = mountAudioControls(this.battery.parentElement ?? this.root, audio, this.battery, { openCredits: (from) => credits.open(from) });
    return {
      dispose() {
        controls.dispose();
        credits.dispose();
      },
    };
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
    // The words go when the bar is short (hud.css); the title keeps them on hover.
    const item = (cls: string, n: number, label: string, hint = '') =>
      `<span class="count count--${cls}" title="${n} ${label}${hint}"><i></i><b>${n}</b><span>${label}</span></span>`;
    this.counts.dataset.n = asleep ? '1' : '3';
    // M5: N goes to the next one who needs you (the blocked, then the done).
    const need = c.needsYou === 1 ? 'needs you' : 'need you';
    const next = c.needsYou + c.done > 0 ? ` · N: go to the next${c.done ? ` (then ${c.done} done)` : ''}` : '';
    this.counts.innerHTML = asleep
      ? item('asleep', c.total, 'asleep')
      : item('working', c.working, 'working') + item('needs_you', c.needsYou, need, next) + (next ? '<kbd class="topbar-key" title="N: go to the next who needs you">N</kbd>' : '') + item('idle', c.idle, 'idle');
  }

  setCity(buildings: number, floors: number, c: Counts): void {
    this.name.textContent = 'City';
    this.setSub(null, `${buildings} ${buildings === 1 ? 'building' : 'buildings'} · ${floors} ${floors === 1 ? 'floor' : 'floors'}`);
    this.setCounts(c);
    this.setUsageTotal(null);
  }

  /** A floor: the one you are on, or (`fire-escape`) the one whose landing you stand on. */
  setFloor(v: FloorView, at: 'floor' | 'fire-escape' = 'floor'): void {
    this.name.textContent = v.session;
    const where = v.level ? `Floor ${v.level.number} of ${v.level.count} · ${v.building?.name ?? ''}` : 'Unassigned lot';
    const state = v.transition === 'waking' ? ' · waking up…' : v.transition === 'sleeping' ? ' · going to sleep…' : v.asleep ? ' · asleep' : '';
    this.setSub(at === 'fire-escape' ? 'fire-escape' : null, where + state);
    this.setCounts(v.counts, v.asleep);
    this.setUsageTotal(usageTotal(v.workers.map((x) => x.worker.usage)));
  }

  /** In the lobby, on the street or on the stairs between landings: the building. */
  setBuilding(name: string, area: Area, floors: number, c: Counts): void {
    this.name.textContent = name;
    this.setSub(area === 'floor' ? null : area, `${floors} ${floors === 1 ? 'floor' : 'floors'}`);
    this.setCounts(c);
    this.setUsageTotal(null);
  }

  /** M5: the floor's usage estimate in the top bar; null hides it (the city, a lobby, nothing priced). */
  private setUsageTotal(t: UsageTotal | null): void {
    const text = t?.text ?? '';
    this.usageEl.hidden = !text;
    if (this.usageEl.textContent !== text) this.usageEl.textContent = text;
    this.usageEl.title = t?.title ?? '';
    this.usageEl.classList.toggle('topbar-usage--flagged', !!t?.flagged);
  }

  private setSub(area: Exclude<Area, 'floor'> | null, text: string): void {
    const key = `${area ?? ''}|${text}`;
    if (this.sub.dataset.key === key) return;
    this.sub.dataset.key = key;
    if (!area) {
      this.sub.textContent = text;
      return;
    }
    const w = WHERE[area];
    const tag = el('span', `where where--${area}`, `${svg(w.icon)}<span></span>`);
    (tag.lastChild as HTMLElement).textContent = w.label;
    this.sub.replaceChildren(tag, document.createTextNode(` · ${text}`));
  }

  /** Walking around: Issues and PRs belong to a floor, so they show only on one. */
  setArea(area: Area): void {
    this.root.dataset.area = area;
    const onFloor = area === 'floor';
    this.issues.hidden = this.prs.hidden = this.hire.hidden = this.mode === 'city' || !onFloor;
    this.syncExtras();
  }

  // ---- M6 start: more top bar buttons (Run on a floor, Team presets in the city) -------

  private readonly extras: Array<{ b: HTMLButtonElement; show: (mode: 'city' | 'floor', area: string | undefined) => boolean }> = [];

  /** Adds a top bar button right after Hire or Buildings, shown while `show` says so. */
  addTopbarButton(b: HTMLButtonElement, after: 'hire' | 'buildings', show: (mode: 'city' | 'floor', area: string | undefined) => boolean): void {
    const prev = this.extras.filter((x) => x.b.previousElementSibling === (after === 'hire' ? this.hire : this.buildings)).at(-1)?.b;
    (prev ?? (after === 'hire' ? this.hire : this.buildings)).after(b);
    b.type = 'button';
    this.extras.push({ b, show });
    this.syncExtras();
  }

  private syncExtras(): void {
    for (const x of this.extras ?? []) x.b.hidden = !x.show(this.mode, this.root.dataset.area);
  }

  /** M15: the radio's genre name ("Off" when stopped); redraws the bar when you are looking at it. */
  setRadio(name: string): void {
    if (name === this.radioName) return;
    this.radioName = name;
    if (this.lastTarget?.id === 'radio') this.setTarget(this.lastTarget, this.lastWorker);
  }

  /** The look-at prompt bar. */
  setTarget(t: Target | null, w: WorkerView | null): void {
    this.lastTarget = t;
    this.lastWorker = w;
    // Everything the prompt shows for a worker, so a harness/effort-only upsert redraws it too.
    const shown = w ? [w.name, w.display, taskLine(w.worker), modelLabel(w.harness, w.worker.model, w.worker.effort)] : [];
    // M5: the usage and the question on the bar.
    if (w) shown.push(...promptBarKey(w));
    if (w) shown.push(...crewBarKey(w));
    if (t?.id === 'radio') shown.push(this.radioName);
    const key = t ? JSON.stringify([t.kind, t.id, ...shown, ...(t.kind === 'board' ? [this.boardInfo.get(t.id) ?? null] : [])]) : '';
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
      // M5
      const usage = usageChip(w);
      if (usage) line.append(usage);
      const asks = askChip(w); // #57
      if (asks) line.append(asks);
      for (const [k, label, live] of KEYS) {
        const st = this.keyStates.get(k) ?? { live, why: 'Not wired up yet' };
        if (!st.live) {
          keys.append(disabled(k, label, st.why ?? 'Not available'));
          continue;
        }
        const s = el('span', 'key');
        s.append(el('kbd', '', k), document.createTextNode(label));
        keys.append(s);
      }
      this.prompt.setAttribute('aria-label', `${w.name} · ${STATUS_WORD[w.display]} · ${taskLine(w.worker)}${model ? ` · ${model}` : ''}`);
      // M5: Approve / Deny lead for a blocked worker's question.
      keys.prepend(...answerKeyEls(w, this.keyStates.get('answer')));
      const extra = promptBarAria(w);
      if (extra) this.prompt.setAttribute('aria-label', `${this.prompt.getAttribute('aria-label') ?? ''} · ${extra}`);
    } else if (t.kind === 'desk') {
      line.append(text('prompt-name', t.label), text('prompt-task', 'Empty desk'));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Hire'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', `${t.label} · E Hire`);
    } else if (t.kind === 'prop' && t.id === 'reception') {
      line.append(text('prompt-name', 'Reception'), text('prompt-task', 'Ask where everyone is: the floor directory'));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Directory'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', 'Reception · E Directory');
    } else if (t.kind === 'prop' && t.id === 'elevator') {
      line.append(text('prompt-name', 'Elevator'), text('prompt-task', 'Ride to another floor, wake one up or put it to sleep'));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Elevator'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', 'Elevator · E Elevator');
    } else if (t.kind === 'prop' && t.id === 'radio') {
      // M15: the office radio: E cycles the genre (Off is a stop), R skips the track.
      const off = this.radioName === 'Off';
      line.append(text('prompt-name', 'Radio'), text('prompt-task', this.radioName));
      const next = el('span', 'key');
      next.append(el('kbd', '', 'E'), document.createTextNode('Next genre'));
      keys.append(next);
      if (off) keys.append(disabled('R', 'Next track', 'The radio is off: E picks a genre'));
      else {
        const skip = el('span', 'key');
        skip.append(el('kbd', '', 'R'), document.createTextNode('Next track'));
        keys.append(skip);
      }
      this.prompt.setAttribute('aria-label', `Radio: ${this.radioName} · E next genre · R next track`);
    } else if (t.kind === 'own-desk') {
      // #20: your desk in the corner office.
      line.append(text('prompt-name', t.label), text('prompt-task', `${t.name === 'You' ? 'Yours' : t.name} · look out over the whole floor`));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Sit'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', `${t.label} · E Sit`);
    } else if (t.kind === 'board' && (t.id === 'board.issues' || t.id === 'board.prs')) {
      // M7: the wall boards open their overlays.
      const info = this.boardInfo.get(t.id);
      const name = t.id === 'board.issues' ? 'Issues board' : 'Pull requests';
      line.append(text('prompt-name', name), text('prompt-task', info?.task ?? 'Waiting for the bridge…'));
      if (info && !info.live) keys.append(disabled('E', 'Open', info.why ?? 'Not available'));
      else {
        const k = el('span', 'key');
        k.append(el('kbd', '', 'E'), document.createTextNode('Open'));
        keys.append(k);
      }
      this.prompt.setAttribute('aria-label', `${name} · E Open`);
    } else if (t.kind === 'board' || t.kind === 'prop') {
      line.append(text('prompt-name', t.label), text('prompt-task', `Placeholder until ${t.milestone}`));
      keys.append(disabled('E', 'Open', `Arrives in ${t.milestone}`));
      this.prompt.setAttribute('aria-label', t.label);
    }
    const crew = t.kind === 'worker' && w ? crewLine(w) : null;
    this.prompt.replaceChildren(...(crew ? [line, crew, keys] : [line, keys]));
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
    const first = [this.back, this.buildings, this.issues, this.prs, this.elevator, this.hire, this.battery].find((b) => !b.hidden);
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

  toast(msg: string, ms = 3200, kind: 'info' | 'error' = 'info', soft = false): void {
    // A soft toast (M15's "now playing") never covers a message that is still up.
    if (soft && !this.toastEl.hidden && !this.toastSoft) return;
    this.toastSoft = soft;
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

  /** M7: what the wall board you look at says (`task`), and whether E opens it (`live`, else `why`); null: nothing yet. */
  private readonly boardInfo = new Map<string, { task: string; live: boolean; why?: string }>();

  setBoardInfo(id: 'board.issues' | 'board.prs', info: { task: string; live: boolean; why?: string } | null): void {
    const cur = this.boardInfo.get(id);
    if (info ? cur?.task === info.task && cur.live === info.live && cur.why === info.why : !cur) return;
    if (info) this.boardInfo.set(id, info);
    else this.boardInfo.delete(id);
    this.promptKey = '';
  }

  /** M7: the top bar's Issues / PRs buttons say why they cannot show a board (an older bridge, no repo). */
  setBoardButtons(why: string | null): void {
    for (const b of [this.issues, this.prs]) {
      b.setAttribute('aria-disabled', why ? 'true' : 'false');
      b.classList.toggle('btn--off', !!why);
    }
    this.issues.title = why ?? 'Issues: this floor’s board as a list';
    this.prs.title = why ?? 'Pull requests: this floor’s open pull requests as a list';
  }

  /** M5: overrides a worker key's state from KEYS (null: as KEYS says); the prompt redraws on the next setTarget. */
  setKeyState(key: string, state: { live: boolean; why?: string } | null): void {
    const cur = this.keyStates.get(key);
    if (state ? cur?.live === state.live && cur.why === state.why : !cur) return;
    if (state) this.keyStates.set(key, state);
    else this.keyStates.delete(key);
    this.promptKey = '';
  }
}

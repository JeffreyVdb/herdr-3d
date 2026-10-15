import type { ConnState } from '../net/client';
import type { HireOptions } from '../net/protocol';
import { modelText, STATUS_WORD, taskLine, type Display } from '../world/derive';
import type { Counts, FloorView, WorkerView } from '../world/store';
import type { Target } from '../render/office';
import type { Area } from '../world/building';
import { CHIP_TEXT } from '../world/derive';
import { ICON as DOM_ICON } from './dom';
import { mountAudioControls } from './audioControls';
import { AboutDialog } from './about';
import { SettingsDialog } from './settings';
import { MusicCredits } from './credits';
import type { BuildInfo } from '../version';
import { answerKeyEls, promptBarAria, promptBarKey, usageChip, askChip } from './promptBar';
// M6 crew: role, run, issue and report on the bar.
import { crewBarKey, crewLine } from './crewBar';
import { usageTotal, type UsageTotal } from '../world/usage';
import type { GameAudio } from '../audio';
import { backdropPolicy } from './dismiss';
import { keyName, withKey } from '../input/shortcuts';
import { countItems } from '../world/overview';

/** Authored 24×24 stroke icons, one weight. */
const ICON = {
  back: '<path d="M14.5 6 8.5 12l6 6"/>',
  issues: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  prs: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5 10.5 7l2 2"/>',
  /** #91: a cog (the floor settings' `DOM_ICON.gear` is a sun, which reads as brightness here). */
  gear: '<circle cx="12" cy="12" r="3"/><path d="M10.6 3.6h2.8l.5 2.2 1.4.6 1.9-1.2 2 2-1.2 1.9.6 1.4 2.2.5v2.8l-2.2.5-.6 1.4 1.2 1.9-2 2-1.9-1.2-1.4.6-.5 2.2h-2.8l-.5-2.2-1.4-.6-1.9 1.2-2-2 1.2-1.9-.6-1.4-2.2-.5v-2.8l2.2-.5.6-1.4-1.2-1.9 2-2 1.9 1.2 1.4-.6z"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5.2M12 7.9v.1"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19 13 11"/>',
  building: DOM_ICON.building,
  lift: DOM_ICON.lift,
  stairs: '<path d="M4 19h4.5v-4.5H13V10h4.5V5.5H20"/>',
  door: '<path d="M6.5 20V5.2c0-.7.5-1.2 1.2-1.2h8.6c.7 0 1.2.5 1.2 1.2V20M4 20h16"/><circle cx="14.4" cy="12.4" r="1.1" fill="currentColor" stroke="none"/>',
  street: '<path d="M5 20 9.5 4M19 20 14.5 4M12 5.5v2M12 10.5v2.5M12 16.5v3"/>',
  /** #118: the floor overview, a board of rows with their lights. */
  overview: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="7.5" cy="9" r="1.1" fill="currentColor"/><circle cx="7.5" cy="12.5" r="1.1" fill="currentColor"/><circle cx="7.5" cy="16" r="1.1" fill="currentColor"/><path d="M10.5 9h6.5M10.5 12.5h5M10.5 16h6"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  palette: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/>',
  /** #213: the dictation bar, a microphone. */
  mic: '<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>',
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

/**
 * Everything the look-at bar shows for a worker, the key it redraws on. #229: the shown model has no harness word and
 * a readable name, so the harness and the exact model id are in it too: a harness- or id-only upsert redraws it.
 */
export function workerShown(w: WorkerView, options: HireOptions): string[] {
  const { model, effort } = w.worker;
  return [w.name, w.display, taskLine(w.worker), modelText(w.harness, model, effort, options), w.harness ?? '', model ?? '', effort ?? ''];
}

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
  ['X', 'Send home', true],
  ['F', 'Handoff', true], // #223: file the last reply, as written
];

export type HudAction = 'city' | 'issues' | 'prs' | 'overview' | 'overview.all' | 'battery' | 'buildings' | 'elevator' | 'hire' | 'palette' | 'dictate';

export interface PlanLabel {
  x: number;
  y: number;
  text: string;
  kind: 'prop' | 'worker' | 'desk';
  display?: Display;
}

/** A toast's weight: `info` says what happened; `warn` (#186) that it worked, with a catch you should know; `error` that it failed or needs you. */
export type ToastKind = 'info' | 'warn' | 'error';

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
  /** #118: the floor overview (O), next to Issues / PRs. */
  private readonly overview = el('button', 'btn btn--overview', `${svg(ICON.overview)}<span>Overview</span><i class="topbar-key" aria-hidden="true"></i>`);
  /** #188: every floor's overview, in the City section: wherever the floor's own is not (the city, a lobby, the street). */
  private readonly overviewAll = el('button', 'btn btn--overview btn--overview-all', `${svg(ICON.overview)}<span>Overview</span><i class="topbar-key" aria-hidden="true"></i>`);
  private readonly battery = el('button', 'btn btn--battery', `${svg(ICON.leaf)}<span>Battery saver</span>`);
  private readonly settings = el('button', 'btn', `${svg(ICON.gear)}<span>Settings</span>`);
  private readonly about = el('button', 'btn', `${svg(ICON.info)}<span>About</span>`);
  /** The floor you are on, as a plate: the one thing the bar must always say. A click opens the elevator. */
  private readonly plate = el('button', 'floor-plate');
  private readonly menuBtn = el('button', 'btn btn--menu', `${svg(ICON.menu)}<span>Menu</span>`);
  private readonly menu = el('div', 'topbar-menu');
  private readonly menuFloor = el('div', 'menu-sec');
  private readonly menuCity = el('div', 'menu-sec');
  private readonly menuGame = el('div', 'menu-sec');
  private readonly paletteRow = el('button', 'btn menu-all', `${svg(ICON.palette)}<span>All commands…</span><i class="menu-key" aria-hidden="true"></i>`);
  /** #213: the dictation bar, from every view (the mouse's way to it; the chord is the keyboard's). */
  private readonly dictateRow = el('button', 'btn menu-all menu-dictate', `${svg(ICON.mic)}<span>Dictate a command…</span><i class="menu-key" aria-hidden="true"></i>`);
  private openAboutDialog: (() => void) | null = null;
  /** #92: shown while an AI model is set up but cannot be used (a rejected key, a missing part); a click opens Settings. */
  private readonly aiChip = el('button', 'ai-chip', '<i></i><span></span>');
  private readonly buildings = el('button', 'btn', `${svg(ICON.building)}<span>Buildings</span>`);
  /** On a floor: its building's elevator panel, for keyboards and when the elevator is out of sight. */
  private readonly elevator = el('button', 'btn', `${svg(ICON.lift)}<span>Elevator</span>`);
  /** M4: on a floor, hire at its first free desk. */
  private readonly hire = el('button', 'btn btn--hire', `${svg(ICON.hire)}<span>Hire</span>`);
  private readonly conn = el('span', 'conn', '<i></i><span></span>');
  /** #57: the bridge in use's name, what the chip says instead of the connection, and the connection last shown. */
  private bridgeName: string | null = null;
  private connOverride: { text: string; title: string; phase: string } | null = null;
  private lastConn: [ConnState, boolean, number] | null = null;
  private readonly reticle = el('div', 'reticle');
  private readonly prompt = el('div', 'prompt');
  private readonly hint = el('div', 'hint');
  private readonly plan = el('div', 'plan');
  private readonly planCard = el('div', 'plan-card');
  private readonly planLabels = el('div');
  private readonly you = el('div', 'plan-you', svg('<path d="M12 3 19 20 12 16 5 20z"/>'));
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
  /** M17: what a look-only prop (no milestone, no E) says it shows, by prop id: the clock's time. */
  private readonly propInfo = new Map<string, string>();
  private lastTarget: Target | null = null;
  private lastWorker: WorkerView | null = null;
  private mode: 'city' | 'floor' = 'city';
  /** M5: worker keys shown other than KEYS says (live, or disabled and why); see setKeyState. */
  private readonly keyStates = new Map<string, { live: boolean; why?: string }>();
  /** #229: the bridge's harness catalog, for the models' readable names (the app's store). */
  hireOptions: () => HireOptions = () => ({});

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
    this.plate.type = 'button';
    place.append(this.back, this.plate, title);
    const actions = el('div', 'topbar-actions');
    this.battery.setAttribute('aria-pressed', 'false');
    this.battery.setAttribute('aria-label', 'Battery saver');
    this.settings.setAttribute('aria-label', 'Settings');
    this.settings.setAttribute('aria-haspopup', 'dialog');
    this.settings.type = 'button';
    this.aiChip.type = 'button';
    this.aiChip.hidden = true;
    this.aiChip.setAttribute('aria-haspopup', 'dialog');
    this.about.title = 'About: game, helper and bridge versions';
    this.about.setAttribute('aria-label', 'About');
    this.about.setAttribute('aria-haspopup', 'dialog');
    this.about.type = 'button';
    this.overview.setAttribute('aria-label', 'Overview');
    this.overview.setAttribute('aria-haspopup', 'dialog');
    this.overviewAll.setAttribute('aria-label', 'All-floors overview');
    this.overviewAll.setAttribute('aria-haspopup', 'dialog');
    // The menu: everything that is a command (each also has a key), in groups; the bar keeps what carries state.
    this.menuFloor.dataset.title = 'This floor';
    this.menuCity.dataset.title = 'City';
    this.menuGame.dataset.title = 'Game';
    this.menuFloor.append(this.hire, this.issues, this.prs, this.overview, this.elevator);
    this.menuCity.append(this.buildings, this.overviewAll);
    this.menuGame.append(this.settings, this.about, this.battery);
    this.menu.append(this.menuFloor, this.menuCity, this.menuGame, this.dictateRow, this.paletteRow);
    this.refreshKeyTitles();
    this.menu.id = 'topbar-menu';
    this.menu.setAttribute('popover', 'auto');
    this.menu.setAttribute('role', 'group');
    this.menu.setAttribute('aria-label', 'Menu');
    this.menuBtn.type = 'button';
    this.menuBtn.popoverTargetElement = this.menu;
    this.menuBtn.setAttribute('aria-haspopup', 'true');
    this.menuBtn.setAttribute('aria-expanded', 'false');
    this.paletteRow.type = 'button';
    this.paletteRow.addEventListener('click', () => this.emit('palette'));
    this.dictateRow.type = 'button';
    this.dictateRow.setAttribute('aria-haspopup', 'dialog');
    this.dictateRow.addEventListener('click', () => this.emit('dictate'));
    this.menu.addEventListener('toggle', (e) => {
      const open = (e as ToggleEvent).newState === 'open';
      this.menuBtn.setAttribute('aria-expanded', String(open));
      if (open) this.menuRows().find((b) => b.getAttribute('aria-disabled') !== 'true')?.focus();
    });
    // A row that does something closes the menu first (in the capture phase, so what the row opens takes the focus and hands it back to the Menu button, not to a row that is no longer on screen); the sound control keeps it open (its sliders are adjusted, not pressed).
    this.menu.addEventListener(
      'click',
      (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b || b.closest('.audio-ctl')) return;
        this.menuBtn.focus();
        this.menu.hidePopover();
      },
      true,
    );
    this.menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = this.menuRows();
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0 && !rows.length) return;
      e.preventDefault();
      rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
    });
    this.plate.addEventListener('click', () => this.emit('elevator'));
    actions.append(this.aiChip, this.conn, this.menuBtn, this.menu);
    bar.append(place, this.counts, actions);
    this.counts.after(this.usageEl);
    this.usageEl.hidden = true;
    new ResizeObserver(() => this.root.style.setProperty('--topbar-bottom', `${bar.getBoundingClientRect().bottom.toFixed(1)}px`)).observe(bar);
    // The look-at bar grows when its lines wrap (a narrow screen, a report request): the hint above it rises with it (hud.css).
    new ResizeObserver(() => this.root.style.setProperty('--prompt-h', `${this.prompt.offsetHeight}px`)).observe(this.prompt);
    for (const [b, a] of [
      [this.back, 'city'],
      [this.issues, 'issues'],
      [this.prs, 'prs'],
      [this.overview, 'overview'],
      [this.overviewAll, 'overview.all'],
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
    this.issues.hidden = this.prs.hidden = this.overview.hidden = mode === 'city';
    this.overviewAll.hidden = mode !== 'city' && this.root.dataset.area === 'floor';
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
  /** #147: the About dialog from the command palette (the same as the top bar's button). */
  openAbout(): void {
    this.openAboutDialog?.();
  }

  mountAbout(info: BuildInfo): { dispose(): void } {
    const about = new AboutDialog(this.root.parentElement ?? this.root, info);
    const open = () => about.open(this.menuBtn);
    this.openAboutDialog = open;
    this.about.addEventListener('click', open);
    return {
      dispose: () => {
        this.openAboutDialog = null;
        about.dispose();
      },
    };
  }

  /** #91: the Settings window, opened from the top bar's gear (or `,`). The caller adds its sections; see `SettingsDialog`. */
  mountSettings(): SettingsDialog {
    const settings = new SettingsDialog(this.root.parentElement ?? this.root);
    this.settings.addEventListener('click', () => settings.open(this.menuBtn));
    this.aiChip.addEventListener('click', () => settings.open(this.aiChip));
    return settings;
  }

  /** #92: the AI chip (null hides it): which model stopped and that Settings is where to fix it. */
  setAiChip(chip: { text: string; title: string; level: 'warn' | 'error' } | null): void {
    this.aiChip.hidden = !chip;
    if (!chip) return;
    this.aiChip.dataset.level = chip.level;
    this.aiChip.title = chip.title;
    this.aiChip.setAttribute('aria-label', `${chip.text}. ${chip.title}`);
    const span = this.aiChip.querySelector('span');
    if (span) span.textContent = chip.text;
  }

  /** M13: the screen share control, in the top bar before Settings and About; shown everywhere (a share is the game's, not a floor's). */
  mountScreenShare(el: HTMLElement): void {
    // Starting a share is a command (the menu); the LIVE tape and Stop are state (the bar, where they cannot be missed).
    const start = el.querySelector('.share-start');
    if (start) this.menuGame.prepend(start);
    this.aiChip.before(el);
  }

  /** M3b: the sound control (mute + volume) in the top bar, before the battery toggle. */
  mountAudio(audio: GameAudio): { dispose(): void } {
    // M15: the Music credits panel, opened from the sound control.
    const credits = new MusicCredits(this.root.parentElement ?? this.root);
    const controls = mountAudioControls(this.battery.parentElement ?? this.root, audio, this.battery, { openCredits: () => credits.open(this.menuBtn) });
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

  /** #57: the name of the bridge in use, on the chip's tooltip (null: none, or no helper). */
  setBridgeName(name: string | null): void {
    this.bridgeName = name;
    if (this.lastConn) this.setConn(...this.lastConn);
  }

  /** #57: what the chip says instead of the connection (a switch under way, no bridge configured); null: the connection again. */
  setConnOverride(o: { text: string; title: string; phase: string } | null): void {
    this.connOverride = o;
    if (this.lastConn) this.setConn(...this.lastConn);
    else this.paintConn('', '', 'stopped');
  }

  setConn(s: ConnState, fixture: boolean, now: number): void {
    this.lastConn = [s, fixture, now];
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
    // M13: under 1100 px the words go (screenShare.css) and the title carries them.
    this.paintConn(text, s.phase === 'waiting' || s.phase === 'failed' ? s.reason : text, s.phase);
  }

  private paintConn(text: string, title: string, phase: string): void {
    const o = this.connOverride;
    if (o) [text, title, phase] = [o.text, o.title, o.phase];
    else if (this.bridgeName) title = `${title} · Bridge: ${this.bridgeName}`;
    this.conn.dataset.phase = phase;
    this.conn.title = title;
    const span = this.conn.querySelector('span');
    if (span && span.textContent !== text) span.textContent = text;
  }

  private setCounts(c: Counts, asleep = false): void {
    // The words go when the bar is short (hud.css); the title keeps them on hover.
    const item = (cls: string, n: number, label: string, hint = '') =>
      `<span class="count count--${cls}" title="${n} ${label}${hint}"><i></i><b>${n}</b><span>${label}</span></span>`;
    // #98: those waiting on their own background tasks have a count of their own (never idle, never in N), shown while any do.
    const waiting = !asleep && c.waiting > 0;
    this.counts.dataset.n = asleep ? '1' : waiting ? '4' : '3';
    // M5: N goes to the next one who needs you (the blocked, then the done).
    const nk = keyName('next-need');
    const next = c.needsYou + c.done > 0 ? ` · ${nk}: go to the next${c.done ? ` (then ${c.done} done)` : ''}` : '';
    // #118: the same items the floor overview's header shows (`countItems`).
    this.counts.innerHTML = countItems(c, asleep)
      .map((x) =>
        x.kind === 'needs_you'
          ? item('needs_you', x.n, x.label, next) + (next ? `<kbd class="topbar-key" title="${nk}: go to the next who needs you">${nk}</kbd>` : '')
          : item(x.kind, x.n, x.label, x.kind === 'waiting' ? ' on their background tasks' : ''),
      )
      .join('');
  }

  setCity(buildings: number, floors: number, c: Counts): void {
    this.name.textContent = 'City';
    this.setPlate(null);
    this.setSub(null, `${buildings} ${buildings === 1 ? 'building' : 'buildings'} · ${floors} ${floors === 1 ? 'floor' : 'floors'}`);
    this.setCounts(c);
    this.setUsageTotal(null);
  }

  /** The plate: the floor's number out of the building's floors, a place's glyph, or (null) nothing. */
  private setPlate(p: { floor: number; of: number } | { where: Exclude<Area, 'floor'> } | null): void {
    const key = p ? ('floor' in p ? `f${p.floor}/${p.of}` : p.where) : '';
    if (this.plate.dataset.key === key) return;
    this.plate.dataset.key = key;
    this.plate.hidden = !p;
    if (!p) return;
    if ('floor' in p) {
      this.plate.dataset.kind = 'floor';
      this.plate.innerHTML = `<small aria-hidden="true">Floor</small><span class="floor-plate-n" aria-hidden="true"><b>${p.floor}</b><i>/${p.of}</i></span>`;
      this.plate.setAttribute('aria-label', `Floor ${p.floor} of ${p.of}. Open the elevator`);
      this.plate.title = withKey(`Floor ${p.floor} of ${p.of}: open the elevator`, 'elevator');
    } else {
      const w = WHERE[p.where];
      this.plate.dataset.kind = 'where';
      this.plate.innerHTML = `${svg(w.icon)}<small aria-hidden="true">${w.label}</small>`;
      this.plate.setAttribute('aria-label', `${w.label}. Open the elevator`);
      this.plate.title = withKey(`${w.label}: open the elevator`, 'elevator');
    }
  }

  /** A floor: the one you are on, or (`fire-escape`) the one whose landing you stand on. */
  setFloor(v: FloorView, at: 'floor' | 'fire-escape' = 'floor'): void {
    this.name.textContent = v.session;
    this.setPlate(v.level ? { floor: v.level.number, of: v.level.count } : null);
    const where = v.level ? (v.building?.name ?? '') : 'Unassigned lot';
    const state = v.transition === 'waking' ? ' · waking up…' : v.transition === 'sleeping' ? ' · going to sleep…' : v.asleep ? ' · asleep' : '';
    this.setSub(at === 'fire-escape' ? 'fire-escape' : null, where + state);
    this.setCounts(v.counts, v.asleep);
    this.setUsageTotal(usageTotal(v.workers.map((x) => x.worker.usage)));
  }

  /** In the lobby, on the street or on the stairs between landings: the building. */
  setBuilding(name: string, area: Area, floors: number, c: Counts): void {
    this.name.textContent = name;
    this.setPlate(area === 'floor' ? null : { where: area });
    this.setSub(null, `${floors} ${floors === 1 ? 'floor' : 'floors'}`);
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
    this.issues.hidden = this.prs.hidden = this.overview.hidden = this.hire.hidden = this.mode === 'city' || !onFloor;
    this.overviewAll.hidden = this.mode !== 'city' && onFloor; // #188: one Overview at a time
    this.syncExtras();
  }

  // ---- M6 start: more top bar buttons (Run on a floor, Team presets in the city) -------

  private readonly extras: Array<{ b: HTMLButtonElement; show: (mode: 'city' | 'floor', area: string | undefined) => boolean }> = [];

  /** Adds a top bar button right after Hire or Buildings, shown while `show` says so. */
  addTopbarButton(b: HTMLButtonElement, after: 'hire' | 'buildings', show: (mode: 'city' | 'floor', area: string | undefined) => boolean): void {
    const prev = this.extras.filter((x) => x.b.previousElementSibling === (after === 'hire' ? this.hire : this.buildings)).at(-1)?.b;
    (prev ?? (after === 'hire' ? this.hire : this.buildings)).after(b);
    b.type = 'button';
    if (b.dataset.action === 'run') b.dataset.key = keyName('run');
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

  /** M17: the line a look-only prop's bar shows (the clock: `14:05 · Wed 30 Sep · Europe/Brussels`); redraws it when looked at. */
  setPropInfo(id: string, info: string): void {
    if (this.propInfo.get(id) === info) return;
    this.propInfo.set(id, info);
    if (this.lastTarget?.id === id) this.setTarget(this.lastTarget, this.lastWorker);
  }

  /** M13: what the whiteboard says when looked at (its version, the agents' pins its render does not show yet). */
  setWhiteboard(st: { version: number; author: string; stale: boolean; stale_pins: unknown[] } | null): void {
    const pins = st?.stale_pins.length ?? 0;
    const info = !st || !st.version ? 'Empty · draw the first thing' : pins ? `${pins} new pin${pins === 1 ? '' : 's'} · last change by ${st.author}` : `Last change by ${st.author}`;
    this.setPropInfo('whiteboard', info);
  }

  /** The look-at prompt bar. */
  setTarget(t: Target | null, w: WorkerView | null): void {
    this.lastTarget = t;
    this.lastWorker = w;
    const shown = w ? workerShown(w, this.hireOptions()) : [];
    // M5: the usage and the question on the bar.
    if (w) shown.push(...promptBarKey(w));
    if (w) shown.push(...crewBarKey(w));
    if (t?.id === 'radio') shown.push(this.radioName);
    if (t && this.propInfo.has(t.id)) shown.push(this.propInfo.get(t.id) ?? '');
    const key = t ? JSON.stringify([t.kind, t.id, ...shown, ...(t.kind === 'board' ? [this.boardInfo.get(t.id) ?? null, this.boardHolder] : [])]) : '';
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
      const model = modelText(w.harness, w.worker.model, w.worker.effort, this.hireOptions());
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
      // The crosshair is on a note's holder tag: a click goes to that worker.
      if (t.id === 'board.issues' && this.boardHolder) {
        const k = el('span', 'key');
        k.append(el('kbd', '', 'Click'), document.createTextNode(`Go to ${this.boardHolder}`));
        keys.append(k);
      }
      this.prompt.setAttribute('aria-label', `${name} · E Open`);
    } else if (t.kind === 'prop' && t.id === 'tv') {
      // M13: the screen-share TV says whether it shows your screen; the top bar's control starts and stops it.
      const info = this.propInfo.get('tv') ?? 'Off · Share screen in the top bar';
      line.append(text('prompt-name', t.label), text('prompt-task', info));
      this.prompt.setAttribute('aria-label', `${t.label}: ${info}`);
    } else if (t.kind === 'prop' && t.id === 'screen.overview') {
      // #118: the lounge wall's big screen opens the floor overview (O does from anywhere on the floor).
      line.append(text('prompt-name', 'Floor overview'), text('prompt-task', 'Everyone on this floor: who works, who waits on you, on which ticket'));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Open'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', `Floor overview · E Open · ${keyName('overview')} from anywhere on the floor`);
    } else if (t.kind === 'prop' && t.id === 'whiteboard') {
      // M13: the floor's whiteboard opens its editor.
      const info = this.propInfo.get('whiteboard') ?? 'Draw, paste a screenshot, pin a drop';
      line.append(text('prompt-name', t.label), text('prompt-task', info));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Open'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', `${t.label}: ${info} · E Open`);
    } else if (t.kind === 'prop' && t.id === 'filing') {
      // #223: the floor's filing cabinet: its handoffs (the drawers fill as they come).
      const info = this.propInfo.get('filing') ?? 'The floor’s handoffs';
      line.append(text('prompt-name', t.label), text('prompt-task', info));
      const k = el('span', 'key');
      k.append(el('kbd', '', 'E'), document.createTextNode('Open'));
      keys.append(k);
      this.prompt.setAttribute('aria-label', `${t.label}: ${info} · E Open`);
    } else if ((t.kind === 'board' || t.kind === 'prop') && t.milestone === null) {
      // M17: a prop that is only looked at (the clock): what it shows, no key.
      const info = this.propInfo.get(t.id) ?? '';
      line.append(text('prompt-name', t.label), text('prompt-task', info));
      this.prompt.setAttribute('aria-label', info ? `${t.label}: ${info}` : t.label);
    } else if (t.kind === 'board' || t.kind === 'prop') {
      line.append(text('prompt-name', t.label), text('prompt-task', `Placeholder until ${t.milestone}`));
      keys.append(disabled('E', 'Open', `Arrives in ${t.milestone}`));
      this.prompt.setAttribute('aria-label', t.label);
    }
    const crew = t.kind === 'worker' && w ? crewLine(w) : null;
    this.prompt.replaceChildren(...(crew ? [line, crew, keys] : keys.childElementCount ? [line, keys] : [line]));
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

  /** Keyboard route into the top bar: focuses its first control (Back on a floor, else the floor plate, else the menu button); Enter on the menu opens it. */
  focusTopbar(): void {
    [this.back, this.plate, this.menuBtn].find((b) => !b.hidden)?.focus();
  }

  /** The menu's rows that can be reached, in order (a hidden row, or a group with none, is skipped). */
  private menuRows(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('[hidden]') && !b.hidden && b.offsetParent !== null && !b.closest('.audio-pop'));
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

  toast(msg: string, ms = 3200, kind: ToastKind = 'info', soft = false): void {
    // A soft toast (M15's "now playing") never covers a message that is still up.
    if (soft && !this.toastEl.hidden && !this.toastSoft) return;
    this.toastSoft = soft;
    this.toastEl.textContent = msg;
    this.toastEl.dataset.kind = kind;
    this.toastEl.hidden = false;
    this.placeToast();
    // A toast right after a screen dialog closed (a hire's): the limits plate that dialog folded is back a moment later.
    requestAnimationFrame(() => this.toastEl.hidden || this.placeToast());
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), ms);
  }

  /** A long toast (M13's macOS denial) that the plan limits panel would cover goes under the panel instead. */
  private placeToast(): void {
    this.toastEl.style.top = '';
    const l = this.root.ownerDocument.querySelector('[data-hook="limits"]')?.getBoundingClientRect();
    if (!l || l.width === 0) return;
    const t = this.toastEl.getBoundingClientRect();
    if (t.left < l.right && l.left < t.right && t.top < l.bottom && l.top < t.bottom) this.toastEl.style.top = `${this.toastEl.offsetTop + l.bottom + 8 - t.top}px`;
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

  /** Whose tag on an issue note is under the aim (null: none): the prompt on the board adds the click. */
  private boardHolder: string | null = null;

  setBoardHolder(name: string | null): void {
    if (name === this.boardHolder) return;
    this.boardHolder = name;
    this.promptKey = '';
  }

  /** #124: the top bar's buttons that have a key say which (their titles), as this keyboard labels it. */
  refreshKeyTitles(): void {
    this.battery.title = withKey('Battery saver: lower frame rates', 'battery');
    this.settings.title = withKey('Settings', 'settings');
    this.back.title = withKey('Back to the city', 'leave');
    this.buildings.title = withKey('Buildings: create, rename and arrange buildings and floors', 'buildings');
    this.elevator.title = withKey('Elevator: ride to another floor, wake or sleep floors, floor settings', 'elevator');
    this.hire.title = `Hire a worker at the first free desk on this floor (${keyName('hire')}), or look at a desk’s + and press E`;
    this.overview.title = withKey('Floor overview: everyone on this floor and what they are doing', 'overview');
    this.overview.setAttribute('aria-keyshortcuts', keyName('overview'));
    this.overview.querySelector('.topbar-key')?.setAttribute('data-key', keyName('overview'));
    this.overviewAll.title = withKey('All-floors overview: every floor’s workers, who is still running', 'overview');
    this.overviewAll.setAttribute('aria-keyshortcuts', keyName('overview'));
    this.overviewAll.querySelector('.topbar-key')?.setAttribute('data-key', keyName('overview'));
    // The caps the menu draws beside each row (the table's, as this keyboard labels them).
    for (const [b, id] of [[this.hire, 'hire'], [this.issues, 'issues'], [this.prs, 'prs'], [this.elevator, 'elevator'], [this.buildings, 'buildings'], [this.settings, 'settings'], [this.battery, 'battery']] as const) b.dataset.key = keyName(id);
    this.paletteRow.querySelector('.menu-key')?.setAttribute('data-key', keyName('palette'));
    this.dictateRow.querySelector('.menu-key')?.setAttribute('data-key', keyName('dictate'));
    this.dictateRow.title = withKey('Dictate a command: say, type or paste what to do (hiring for now)', 'dictate');
    this.dictateRow.setAttribute('aria-keyshortcuts', keyName('dictate').replace('⌘', 'Meta').replace(/^Ctrl/, 'Control'));
    this.menuBtn.title = `Menu: everything you can do here (${keyName('palette')} searches it)`;
    this.issues.title = this.boardWhy ?? withKey('Issues: this floor’s board as a list', 'issues');
    this.prs.title = this.boardWhy ?? withKey('Pull requests: this floor’s open pull requests as a list', 'prs');
  }

  private boardWhy: string | null = null;

  /** M7: the top bar's Issues / PRs buttons say why they cannot show a board (an older bridge, no repo). */
  setBoardButtons(why: string | null): void {
    for (const b of [this.issues, this.prs]) {
      b.setAttribute('aria-disabled', why ? 'true' : 'false');
      b.classList.toggle('btn--off', !!why);
    }
    this.boardWhy = why;
    this.refreshKeyTitles();
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

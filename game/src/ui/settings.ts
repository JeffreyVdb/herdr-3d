import './settings.css';
import { backdropPolicy } from './dismiss';

const NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function closeIcon(): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M6.5 6.5l11 11M17.5 6.5l-11 11');
  s.append(p);
  return s;
}

/** Where a section's settings live: this browser's `localStorage`, or the bridge (shared by every client). */
export type SettingsStore = 'browser' | 'bridge';

const STORE_LABEL: Record<SettingsStore, string> = { browser: 'This browser', bridge: 'Bridge' };
const STORE_TITLE: Record<SettingsStore, string> = {
  browser: 'Kept in this browser only',
  bridge: 'Kept on the bridge: every client sees the same',
};

/** What a section's `render` hands back: both parts are optional. */
export interface SectionHandle {
  /** The dialog is about to show: re-read whatever another tab or the page address may have moved. */
  open?(): void;
  /** The section is removed or the dialog disposed: drop the listeners it added. */
  dispose?(): void;
}

/** What a section may do to itself beyond its content. */
export interface SectionControl {
  /**
   * Takes the whole section out (#98: a bridge without the feature has nothing to show): its panel, its tab in the
   * navigator and its choice in the picker. Not the same as a section that is only not the one showing (#49).
   */
  setHidden(hidden: boolean): void;
}

/** Fills `body` (under the section's heading and storage label) once, when the section is added. */
export type SectionRender = (body: HTMLElement, section: SectionControl) => SectionHandle | void;

/** The navigator's groups (#49): every section is in exactly one. */
export type SettingsGroup = 'general' | 'workers' | 'ai' | 'integrations';

/** The groups in the order the navigator lists them, whatever order their sections were added in. */
const GROUPS: ReadonlyArray<{ id: SettingsGroup; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'workers', label: 'Workers' },
  { id: 'ai', label: 'AI' },
  { id: 'integrations', label: 'Integrations' },
];

interface Section {
  id: string;
  group: SettingsGroup;
  root: HTMLElement;
  heading: HTMLElement;
  tab: HTMLButtonElement;
  option: HTMLOptionElement;
  handle: SectionHandle;
  /** Taken out by the section itself (`setHidden`): no panel, tab or choice. */
  unavailable: boolean;
  /** Where the content scroller was when another section took over (#49): restored on the way back. */
  scrollTop: number;
}

let serial = 0;

/**
 * The Settings window (#91): everything the player can change, as sections in the About panel's frame. A section
 * is `addSection(id, title, render, { store, group })`: the dialog owns the heading, the "where is this kept" label
 * and the section's place in the navigator, the section owns its content, so a feature (the bridge's follow-up
 * questions, #90) plugs in without touching this file.
 *
 * #49: one section shows at a time. A wide window lists them down the side (a vertical tablist, grouped General,
 * Workers, AI, Integrations; within a group in the order added), a narrow one in a picker above the section. Every
 * section's DOM stays put: a switch only hides and shows, so half-typed fields, errors and pending tests survive it
 * and no section is told anything (its `open` is the dialog's opening, once).
 *
 * It holds inputs, so the backdrop never closes it (`none`, #51): the close button and Esc do, and Esc is the
 * platform's. A modal `<dialog>`; the game's keys do nothing while it is open.
 */
export class SettingsDialog {
  private readonly dialog = el('dialog', 'credits settings');
  private readonly body = el('div', 'panel-body credits-body settings-body');
  private readonly tablist = el('div', 'settings-tabs');
  private readonly groups = new Map<SettingsGroup, { box: HTMLElement; optgroup: HTMLOptGroupElement }>();
  private readonly picker = el('div', 'settings-field settings-pick');
  private readonly select = el('select', 'settings-pick-select');
  private readonly sections: Section[] = [];
  /** The section showing (null: none can show). */
  private active: Section | null = null;
  /** The last section the player chose (or a link revealed): the next open shows it again when it can. */
  private remembered: Section | null = null;
  private opener: HTMLElement | null = null;
  private readonly serial = ++serial;

  constructor(parent: HTMLElement) {
    const head = el('header', 'panel-head');
    const titles = el('div', 'panel-titles');
    const h = el('h2', '', 'Settings');
    h.id = `settings-title-${this.serial}`;
    titles.append(h, el('p', '', 'Everything you can change'));
    const close = el('button', 'btn btn--icon panel-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close (Esc)';
    close.append(closeIcon());
    close.addEventListener('click', () => this.close());
    head.append(titles, close);

    // Wide: the tablist down the side. Group labels sit between the tabs for the eye only: the tablist owns tabs.
    this.tablist.setAttribute('role', 'tablist');
    this.tablist.setAttribute('aria-orientation', 'vertical');
    this.tablist.setAttribute('aria-label', 'Settings sections');
    // Narrow: the same choice as a native picker above the section (one of the two shows, by CSS).
    const pickId = `settings-${this.serial}-pick`;
    const pickLabel = el('label', 'settings-field-label', 'Section');
    pickLabel.htmlFor = pickId;
    this.select.id = pickId;
    this.picker.append(pickLabel, this.select);
    for (const g of GROUPS) {
      const box = el('div', 'settings-nav-group');
      box.dataset.group = g.id;
      box.setAttribute('role', 'none');
      const label = el('div', 'settings-nav-label', g.label);
      label.setAttribute('aria-hidden', 'true');
      box.append(label);
      box.hidden = true;
      this.tablist.append(box);
      const optgroup = el('optgroup');
      optgroup.label = g.label;
      this.groups.set(g.id, { box, optgroup });
    }
    this.tablist.addEventListener('click', (e) => {
      const t = (e.target as Element).closest<HTMLElement>('[role="tab"]');
      const sec = t && this.sections.find((s) => s.tab === t);
      if (sec) this.choose(sec);
    });
    this.tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    this.select.addEventListener('change', () => {
      const sec = this.sections.find((s) => s.id === this.select.value);
      if (sec) this.choose(sec);
    });

    const nav = el('nav', 'settings-nav');
    nav.setAttribute('aria-label', 'Settings sections');
    nav.append(this.tablist);
    const main = el('div', 'settings-main');
    main.append(this.picker, this.body);
    const frame = el('div', 'settings-frame');
    frame.append(nav, main);

    this.body.tabIndex = -1;
    this.dialog.setAttribute('aria-labelledby', h.id);
    this.dialog.append(head, frame);
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });
    // It holds typed fields: a stray click on the backdrop must not drop a half-typed one (#51).
    backdropPolicy(this.dialog, 'none');
    this.syncNav();
    parent.append(this.dialog);
  }

  /** Adds a section to its group in the navigator, after the group's others. Returns what removes it again. Throws on an id already in use or a group the navigator does not have. */
  addSection(id: string, title: string, render: SectionRender, opts: { store: SettingsStore; group: SettingsGroup }): () => void {
    if (this.sections.some((s) => s.id === id)) throw new Error(`settings section “${id}” is already added`);
    const group = this.groups.get(opts.group);
    if (!group) throw new Error(`settings section “${id}” has no navigator group (${String(opts.group)})`);
    const base = `settings-${this.serial}-${id}`;
    const root = el('section', 'settings-section');
    root.dataset.section = id;
    root.dataset.store = opts.store;
    root.id = `${base}-panel`;
    root.setAttribute('role', 'tabpanel');
    const h = el('h3', 'settings-title', title);
    h.id = `${base}-h`;
    const store = el('span', 'settings-store', STORE_LABEL[opts.store]);
    store.title = STORE_TITLE[opts.store];
    const head = el('div', 'settings-section-head');
    head.append(h, store);
    const content = el('div', 'settings-content');
    root.append(head, content);

    const tab = el('button', 'settings-tab', title);
    tab.type = 'button';
    tab.id = `${base}-tab`;
    tab.dataset.tab = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', root.id);
    root.setAttribute('aria-labelledby', tab.id);
    const option = el('option', '', title);
    option.value = id;

    const section: Section = { id, group: opts.group, root, heading: h, tab, option, handle: {}, unavailable: false, scrollTop: 0 };
    this.sections.push(section);
    group.box.append(tab);
    group.optgroup.append(option);
    this.body.append(root);
    // Before render: a section may hide itself while it fills its body.
    const control: SectionControl = { setHidden: (hidden) => this.setUnavailable(section, hidden) };
    this.sync();
    section.handle = render(content, control) ?? {};
    return () => {
      const i = this.sections.indexOf(section);
      if (i < 0) return;
      const focused = this.holdsFocus(section);
      if (this.active === section) this.fallBack(section);
      if (this.remembered === section) this.remembered = null;
      this.sections.splice(i, 1);
      section.handle.dispose?.();
      root.remove();
      tab.remove();
      option.remove();
      this.sync();
      if (focused) this.focusActiveNav();
    };
  }

  /**
   * Shows section `id` from its top and puts the keyboard on its heading (a link from another section or dialog),
   * whatever was showing before; it is what the next open shows too. Callers open the dialog first.
   */
  reveal(id: string): void {
    const sec = this.sections.find((x) => x.id === id);
    if (!sec || sec.unavailable) return;
    this.choose(sec);
    this.body.scrollTop = 0;
    sec.heading.tabIndex = -1;
    sec.heading.focus({ preventScroll: true });
  }

  /** The ids of the sections, in the order they were added. */
  get sectionIds(): string[] {
    return this.sections.map((s) => s.id);
  }

  /** The id of the section showing, or null when there is none to show. */
  get activeSection(): string | null {
    return this.active?.id ?? null;
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    for (const s of this.sections) s.handle.open?.();
    // The section chosen last, when the bridge still offers it; else whatever shows now (or the first).
    const want = this.remembered && !this.remembered.unavailable ? this.remembered : (this.active ?? this.navOrder()[0] ?? null);
    if (want) this.show(want);
    this.dialog.showModal();
    this.body.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    for (const s of this.sections) s.handle.dispose?.();
    this.sections.length = 0;
    this.active = this.remembered = null;
    this.close();
    this.dialog.remove();
  }

  /** The sections that can show, in the navigator's order: by group, then in the order added. */
  private navOrder(): Section[] {
    return GROUPS.flatMap((g) => this.sections.filter((s) => s.group === g.id && !s.unavailable));
  }

  /** The player (or a link) picks `sec`: it shows, and the next open comes back to it. */
  private choose(sec: Section): void {
    this.remembered = sec;
    this.show(sec);
  }

  /** Shows `sec` in place of the section showing, each at the scroll position it was left at. */
  private show(sec: Section | null): void {
    if (sec === this.active) return;
    if (this.active) this.active.scrollTop = this.body.scrollTop;
    this.active = sec;
    this.sync();
    this.body.scrollTop = sec?.scrollTop ?? 0;
  }

  private setUnavailable(sec: Section, unavailable: boolean): void {
    if (sec.unavailable === unavailable) return;
    const focused = unavailable && this.holdsFocus(sec);
    sec.unavailable = unavailable;
    if (unavailable && this.active === sec) this.fallBack(sec);
    this.sync();
    if (focused) this.focusActiveNav();
  }

  /** `sec` (still in the list) is going: the next section that can show takes over, else the one before it, else none. */
  private fallBack(sec: Section): void {
    const order = GROUPS.flatMap((g) => this.sections.filter((s) => s.group === g.id && (s === sec || !s.unavailable)));
    const i = order.indexOf(sec);
    this.show(order[i + 1] ?? order[i - 1] ?? null);
  }

  private holdsFocus(sec: Section): boolean {
    const f = document.activeElement;
    return !!f && (sec.root.contains(f) || sec.tab === f);
  }

  /** After the focused section went: the keyboard goes to the section that took over, on the control that shows. */
  private focusActiveNav(): void {
    if (!this.active) {
      this.body.focus({ preventScroll: true });
      return;
    }
    const wide = getComputedStyle(this.tablist).display !== 'none' && getComputedStyle(this.tablist.parentElement!).display !== 'none';
    (wide ? this.active.tab : this.select).focus({ preventScroll: true });
  }

  /** Up / Down (wrapping), Home / End: the APG's vertical tabs, each move selecting (a switch does no network work). */
  private onTabKey(e: KeyboardEvent): void {
    const order = this.navOrder();
    if (!order.length) return;
    const at = order.findIndex((s) => s.tab === e.target);
    let to: number;
    if (e.key === 'ArrowDown') to = (at + 1) % order.length;
    else if (e.key === 'ArrowUp') to = (at - 1 + order.length) % order.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = order.length - 1;
    else return;
    e.preventDefault();
    const sec = order[to]!;
    this.choose(sec);
    sec.tab.focus();
  }

  /** Every panel, tab and choice to the state: one panel showing, the rest hidden; unavailable ones gone from both navigators. */
  private sync(): void {
    // Nothing showing yet (a fresh dialog, or every section was out): the first that can show does.
    this.active ??= this.navOrder()[0] ?? null;
    for (const s of this.sections) {
      const on = s === this.active;
      s.root.hidden = s.unavailable || !on;
      s.tab.hidden = s.unavailable;
      s.tab.setAttribute('aria-selected', String(on));
      s.tab.tabIndex = on ? 0 : -1;
      s.option.hidden = s.unavailable;
      s.option.disabled = s.unavailable;
    }
    this.syncNav();
  }

  /** Group labels and optgroups only for groups with a section to show; the picker on the section showing. */
  private syncNav(): void {
    const groups: HTMLOptGroupElement[] = [];
    for (const g of GROUPS) {
      const { box, optgroup } = this.groups.get(g.id)!;
      const any = this.sections.some((s) => s.group === g.id && !s.unavailable);
      box.hidden = !any;
      if (any) groups.push(optgroup);
    }
    // Detached, not hidden: an empty optgroup still shows its label in some pickers.
    if (groups.length !== this.select.children.length || groups.some((g, i) => this.select.children[i] !== g)) this.select.replaceChildren(...groups);
    this.picker.hidden = !this.active;
    this.select.value = this.active?.id ?? '';
  }
}

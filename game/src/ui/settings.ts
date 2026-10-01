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

/** Fills `body` (under the section's heading and storage label) once, when the section is added. */
export type SectionRender = (body: HTMLElement) => SectionHandle | void;

interface Section {
  id: string;
  root: HTMLElement;
  handle: SectionHandle;
}

let serial = 0;

/**
 * The Settings window (#91): everything the player can change, as sections in the About panel's frame. A section
 * is `addSection(id, title, render, { store })`: the dialog owns the heading and the "where is this kept" label,
 * the section owns its content, so a feature (the bridge's follow-up questions, #90) plugs in without touching
 * this file. Sections show in the order they were added.
 *
 * It holds inputs, so the backdrop never closes it (`none`, #51): the close button and Esc do, and Esc is the
 * platform's. A modal `<dialog>`; the game's keys do nothing while it is open.
 */
export class SettingsDialog {
  private readonly dialog = el('dialog', 'credits settings');
  private readonly body = el('div', 'panel-body credits-body settings-body');
  private readonly sections: Section[] = [];
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

    this.body.tabIndex = -1;
    this.dialog.setAttribute('aria-labelledby', h.id);
    this.dialog.append(head, this.body);
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.opener?.focus();
      this.opener = null;
    });
    // It holds typed fields: a stray click on the backdrop must not drop a half-typed one (#51).
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  /** Adds a section under the last one. Returns what removes it again. Throws on an id already in use. */
  addSection(id: string, title: string, render: SectionRender, opts: { store: SettingsStore }): () => void {
    if (this.sections.some((s) => s.id === id)) throw new Error(`settings section “${id}” is already added`);
    const root = el('section', 'settings-section');
    root.dataset.section = id;
    root.dataset.store = opts.store;
    const h = el('h3', 'settings-title', title);
    h.id = `settings-${this.serial}-${id}-h`;
    root.setAttribute('aria-labelledby', h.id);
    const store = el('span', 'settings-store', STORE_LABEL[opts.store]);
    store.title = STORE_TITLE[opts.store];
    const head = el('div', 'settings-section-head');
    head.append(h, store);
    const content = el('div', 'settings-content');
    root.append(head, content);
    const section: Section = { id, root, handle: render(content) ?? {} };
    this.sections.push(section);
    this.body.append(root);
    return () => {
      const i = this.sections.indexOf(section);
      if (i < 0) return;
      this.sections.splice(i, 1);
      section.handle.dispose?.();
      root.remove();
    };
  }

  /** The ids of the sections, in the order they show. */
  get sectionIds(): string[] {
    return this.sections.map((s) => s.id);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    for (const s of this.sections) s.handle.open?.();
    this.dialog.showModal();
    this.body.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  dispose(): void {
    for (const s of this.sections) s.handle.dispose?.();
    this.sections.length = 0;
    this.close();
    this.dialog.remove();
  }
}

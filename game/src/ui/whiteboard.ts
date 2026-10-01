/**
 * M13: the whiteboard overlay (look at the board, E). The frame is the game's (navy chrome, the board's aluminium
 * edge, a marker-tray ledge with the board's own actions); the drawing surface inside it is Excalidraw, loaded on the
 * first open (../whiteboard/load.ts). While it is open the game takes no keys and no pointer (app.ts): the overlay
 * covers the canvas and every key belongs to the editor.
 *
 * Esc, in order: Excalidraw's own use first (finishing a text, a line, a crop; closing a menu, a colour popup, a
 * dialog, the sidebar, a context menu or the link editor), then our picker or confirmation, then the selection is
 * dropped, then the drawing tool goes back to the pointer, and only then the board closes. The close button always
 * closes. Closing saves what is left first.
 */

import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, Drop, DropsListAck, WhiteboardState } from '../net/protocol';
import { dropUrl } from '../net/whiteboard';
import { ago, pinsText, statusText, type BoardStatus } from '../whiteboard/model';
import { loadEditor } from '../whiteboard/load';
import type { BoardSession } from '../whiteboard/editor';
import { h, icon, ICON } from './dom';
import './whiteboard.css';

const PIN = '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 12v8"/>';

export interface WhiteboardHost {
  wsUrl(): string;
  author(): string;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  toast(m: string, kind: 'info' | 'error'): void;
  /** A save landed: the room's board shows the new render. */
  saved(s: WhiteboardState): void;
  /** The overlay closed (the game takes keys again). */
  closed(): void;
}

/** What a test can read of the overlay. */
export interface WhiteboardInfo {
  open: boolean;
  floor: string | null;
  loaded: boolean;
  status: BoardStatus['kind'];
  text: string;
  pins: string[];
  picker: boolean;
  confirm: boolean;
}

export class WhiteboardOverlay {
  private readonly root: HTMLDivElement;
  private readonly mount: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly pinsEl: HTMLDivElement;
  private readonly loadingEl: HTMLDivElement;
  private readonly picker: HTMLDivElement;
  private readonly confirmEl: HTMLDivElement;
  private readonly pinBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private floor: string | null = null;
  private session: BoardSession | null = null;
  /** Bumped on every open and close: a load that finishes after its overlay closed is dropped. */
  private gen = 0;
  private status: BoardStatus = { kind: 'loading' };
  private pins: string[] = [];
  private closing: Promise<void> | null = null;
  private returnFocus: HTMLElement | null = null;
  private readonly onKeyCapture = (e: KeyboardEvent) => this.keyCapture(e);

  constructor(
    parent: HTMLElement,
    private readonly host: WhiteboardHost,
  ) {
    this.title = h('span', { class: 'wb-floor' });
    this.statusEl = h('span', { class: 'wb-status', role: 'status', 'aria-live': 'polite' });
    const close = h('button', { class: 'wb-btn wb-close', 'aria-label': 'Close the whiteboard (Esc)', title: 'Close (Esc)', onclick: () => void this.close() }, icon(ICON.close));
    this.mount = h('div', { class: 'wb-canvas' });
    this.loadingEl = h('div', { class: 'wb-loading' }, 'Opening the whiteboard…');
    this.pinBtn = h('button', { class: 'wb-btn', onclick: () => void this.togglePicker() }, icon(PIN), 'Pin a drop');
    this.clearBtn = h('button', { class: 'wb-btn wb-btn--quiet', onclick: () => this.askClear() }, icon(ICON.trash), 'Clear board');
    this.pinsEl = h('div', { class: 'wb-pins', 'aria-live': 'polite' });
    this.picker = h('div', { class: 'wb-picker', role: 'dialog', 'aria-label': 'Pin a recent drop', hidden: true });
    this.confirmEl = h('div', { class: 'wb-confirm', role: 'alertdialog', 'aria-label': 'Clear the whiteboard', hidden: true });
    this.root = h(
      'div',
      { class: 'wb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Whiteboard', hidden: true },
      h(
        'div',
        { class: 'wb-frame' },
        h('header', { class: 'wb-top' }, h('h2', { class: 'wb-title' }, 'Whiteboard'), this.title, this.statusEl, close),
        h('div', { class: 'wb-surface' }, this.mount, this.loadingEl),
        h('footer', { class: 'wb-ledge' }, this.pinBtn, this.clearBtn, this.pinsEl, h('span', { class: 'wb-hint' }, 'Saved for everyone on this floor · the last 20 versions are kept')),
        this.picker,
        this.confirmEl,
      ),
    );
    parent.append(this.root);
  }

  get isOpen(): boolean {
    return this.floor !== null;
  }

  /** Opens the floor's board (loading the editor the first time). */
  async open(floor: string): Promise<void> {
    if (this.closing) await this.closing;
    if (this.floor === floor) return;
    if (this.floor) await this.close();
    const gen = ++this.gen;
    this.floor = floor;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.title.textContent = floor;
    this.root.setAttribute('aria-label', `Whiteboard · ${floor}`);
    this.pins = [];
    this.renderPins();
    this.picker.hidden = true;
    this.confirmEl.hidden = true;
    this.loadingEl.hidden = false;
    this.loadingEl.textContent = 'Opening the whiteboard…';
    this.setStatus({ kind: 'loading' });
    this.root.hidden = false;
    this.root.setAttribute('open', ''); // the limits plate steps aside, as for a screen dialog (ui/limits.ts)
    window.addEventListener('keydown', this.onKeyCapture, true);
    try {
      const mod = await loadEditor();
      if (gen !== this.gen) return;
      const session = mod.openSession({
        wsUrl: this.host.wsUrl(),
        floor,
        mount: this.mount,
        author: () => this.host.author(),
        status: (s) => gen === this.gen && this.setStatus(s),
        stale: (s) => {
          if (gen !== this.gen) return;
          this.pins = pinsText(s);
          this.renderPins();
        },
        saved: (s) => this.host.saved(s),
        link: (url) => this.host.toast(`Links on the board don’t open from the game: ${url}`, 'info'),
      });
      this.session = session;
      await session.open();
      if (gen !== this.gen) return;
      this.loadingEl.hidden = true;
    } catch (err) {
      if (gen !== this.gen) return;
      this.loadingEl.textContent = `The whiteboard could not open: ${err instanceof Error ? err.message : String(err)}. Close it and try again.`;
      this.setStatus({ kind: 'error', message: 'not loaded' });
    }
  }

  /** Saves what is left, then closes. */
  close(): Promise<void> {
    if (!this.floor) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const session = this.session;
      this.picker.hidden = true;
      this.confirmEl.hidden = true;
      if (session?.dirty) this.setStatus({ kind: 'saving' });
      await session?.close().catch(() => undefined);
      this.gen++;
      this.session = null;
      this.floor = null;
      this.root.hidden = true;
      this.root.removeAttribute('open');
      window.removeEventListener('keydown', this.onKeyCapture, true);
      this.mount.replaceChildren();
      this.returnFocus?.focus?.();
      this.host.closed();
    })().finally(() => (this.closing = null));
    return this.closing;
  }

  /** whiteboard.updated: the open board merges it (an agent's pin, another client's save, a clear). */
  updated(s: WhiteboardState): void {
    if (s.floor !== this.floor) return;
    this.session?.remote(s);
  }

  private setStatus(s: BoardStatus): void {
    this.status = s;
    this.statusEl.textContent = statusText(s);
    this.statusEl.dataset.kind = s.kind;
  }

  private renderPins(): void {
    this.pinsEl.replaceChildren(...this.pins.slice(-3).map((p) => h('span', { class: 'wb-pin' }, p)));
    this.pinsEl.hidden = !this.pins.length;
  }

  private keyCapture(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !this.isOpen) return;
    if (!this.picker.hidden || !this.confirmEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      this.picker.hidden = true;
      this.confirmEl.hidden = true;
      this.focusEditor();
      return;
    }
    const verdict = this.session ? this.session.escape() : 'close';
    if (verdict === 'pass') return;
    e.preventDefault();
    e.stopPropagation();
    if (verdict === 'close') void this.close();
  }

  // ---- Pin a drop ------------------------------------------------------------------------------------

  private async togglePicker(): Promise<void> {
    if (!this.picker.hidden) {
      this.picker.hidden = true;
      this.focusEditor();
      return;
    }
    this.confirmEl.hidden = true;
    this.picker.hidden = false;
    this.picker.replaceChildren(h('p', { class: 'wb-picker-note' }, 'Reading Drop Zone…'));
    const r = await this.host.send('drops.list', { limit: 20 });
    if (this.picker.hidden) return;
    if (!r.ok) {
      const why = r.code === 'unknown_command' ? 'This herdr-world can’t list drops yet. Update the bridge to use it.' : r.code === 'drops_unavailable' ? 'Drop Zone’s folder can’t be read on the bridge.' : r.message;
      this.picker.replaceChildren(h('p', { class: 'wb-picker-note' }, why));
      return;
    }
    const drops = (r.data as DropsListAck).drops;
    if (!drops.length) {
      this.picker.replaceChildren(h('p', { class: 'wb-picker-note' }, 'Nothing in Drop Zone yet. Drop a file there and it shows up here.'));
      return;
    }
    const now = Date.now();
    const list = h('ul', { class: 'wb-drops' }, ...drops.map((d) => h('li', {}, this.dropButton(d, now))));
    this.picker.replaceChildren(h('h3', { class: 'wb-picker-title' }, 'Recent drops'), list);
    list.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }

  private dropButton(d: Drop, now: number): HTMLButtonElement {
    const thumb = d.image
      ? h('img', { class: 'wb-drop-img', alt: '', loading: 'lazy', decoding: 'async', src: dropUrl(this.host.wsUrl(), d.path, true) })
      : h('span', { class: 'wb-drop-file' }, (/\.([a-z0-9]{1,5})$/i.exec(d.name)?.[1] ?? 'file').toUpperCase());
    const why = d.image ? ago(d.mtime, now) : d.reason === 'too_large' ? 'Too large to pin' : 'Not an image';
    return h(
      'button',
      { class: 'wb-drop', disabled: !d.image, title: d.path, 'data-path': d.path, onclick: () => void this.pinDrop(d) },
      thumb,
      h('span', { class: 'wb-drop-name' }, d.name),
      h('span', { class: 'wb-drop-meta' }, why),
    );
  }

  /** Keys go back to the editor (Excalidraw takes only the keys aimed at it). */
  private focusEditor(): void {
    this.session?.focus();
  }

  private async pinDrop(d: Drop): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.picker.hidden = true;
    this.focusEditor();
    try {
      const res = await fetch(dropUrl(this.host.wsUrl(), d.path));
      if (!res.ok) throw new Error(`Drop Zone answered ${res.status}`);
      await session.insertImage(await res.blob(), d.name);
    } catch (err) {
      this.host.toast(`${d.name} could not be pinned: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  // ---- Clear -----------------------------------------------------------------------------------------

  private askClear(): void {
    if (!this.floor) return;
    this.picker.hidden = true;
    const floor = this.floor;
    const yes = h('button', { class: 'wb-btn wb-btn--danger', onclick: () => void this.clear(floor) }, 'Clear board');
    const no = h('button', { class: 'wb-btn wb-btn--quiet', onclick: () => ((this.confirmEl.hidden = true), this.focusEditor()) }, 'Keep it');
    this.confirmEl.replaceChildren(
      h('p', { class: 'wb-confirm-text' }, h('strong', {}, `Clear the whiteboard for everyone on ${floor}?`), ' The last 20 versions stay in its history.'),
      h('div', { class: 'wb-confirm-actions' }, no, yes),
    );
    this.confirmEl.hidden = false;
    no.focus();
  }

  private async clear(floor: string): Promise<void> {
    this.confirmEl.hidden = true;
    this.focusEditor();
    // What is drawn but not saved goes into the history first.
    await this.session?.save();
    const r = await this.host.send('whiteboard.clear', { floor, confirm: true, author: this.host.author() });
    if (!r.ok) this.host.toast(`The whiteboard was not cleared: ${r.message}`, 'error');
  }

  /** Test hook. */
  info(): WhiteboardInfo {
    return {
      open: this.isOpen,
      floor: this.floor,
      loaded: !!this.session && this.loadingEl.hidden === true,
      status: this.status.kind,
      text: this.statusEl.textContent ?? '',
      pins: [...this.pins],
      picker: !this.picker.hidden,
      confirm: !this.confirmEl.hidden,
    };
  }

  /** Test hook: the open editor session. */
  get current(): BoardSession | null {
    return this.session;
  }
}

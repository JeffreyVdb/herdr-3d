/**
 * The HUD's top right corner under the top bar: the plan-limits plate (limits.ts) and, under it, #100's inbox chip
 * (inbox.ts). What takes the corner away from them is one rule, kept here: a screen-filling dialog, the seated reading
 * overlay, sitting at a laptop, and on a narrow viewport any open dialog. `CornerWatch` says which of these holds and
 * calls back when one may have changed.
 */

/** Below this width a dialog or the Changes panel spans the screen (limits.css follows the same line). */
export const NARROW = '(max-width: 760px)';

/**
 * The dialogs that fill the screen (the M3 panels, the Issues / Pull requests boards and their item modal, and since
 * #51 the hire dialog, a near-full-screen sheet, #124 the shortcut list, as tall as the window, and #49 Settings, up to
 * 1200 px by 90 % of the window): at any viewport width the plate steps out of them. The About window, the confirm,
 * start-run, send-home, prompt, presets and open-PR dialogs are small and centred; they keep today's behaviour (the
 * plate stays above them in the top layer, and the start-run one shows the limits inline as well). The hire dialog
 * shows the chosen harness's limits inline too, so nothing is lost when the plate folds away over it.
 */
// M13: the whiteboard overlay (a div, ui/whiteboard.ts) carries `open` while it is up, like a dialog; so does #118's
// floor overview (ui/overview.ts), which fills the viewport. #147: the command palette is a small dialog but always the topmost
// modal (it opens over any view, any other dialog): the plate steps out of it into the edge tab (the palette keeps the gutter
// the tab needs, palette.css), and the tab, which lives inside the topmost screen, is the palette's own, so it stays clickable.
// #213: so is the dictation bar, the palette's sibling (dictation.css keeps the same gutter). #223: the filing cabinet
// fills the screen like a board does; #64 schedules: so do the scheduled agents dialog and its form (tall, header right).
export const PALETTE = 'dialog.palette[open], dialog.dictation[open]';
export const SCREEN = `dialog.panel[open], dialog.desk-dlg--board[open], dialog.desk-dlg--item[open], dialog.desk-dlg--hire[open], dialog.desk-dlg--secrets[open], dialog.shortcuts[open], dialog.settings[open], dialog.cab[open], dialog.sch[open], dialog.desk-dlg--sched[open], .wb[open], .ov[open], ${PALETTE}`;

/**
 * The seated reading overlay (the conversation, the Images tab; laptop/index.ts marks the page with `data-reading`) is a
 * screen too, though not a dialog: it covers the plate's corner of the laptop, so the plate steps out of it the same
 * way (edge tab beside it when there is room, else away; Shift+L peeks).
 */
export const READING = '.seat-transcript:not([hidden])';

/** #53: seated at a worker's laptop (laptop/index.ts marks the page with `data-seated`, the glass's right edge in px); the plate is its edge tab beside the glass, or away. */
export const SEATED = 'html[data-seated]';

export class CornerWatch {
  /** Narrow viewports: a dialog or the Changes panel fills the screen, so the corner has no room beside it. */
  private readonly narrow = typeof matchMedia === 'function' ? matchMedia(NARROW) : null;
  private readonly onNarrow = () => this.changed(false);
  private watcher: MutationObserver | null = null;
  /** When each screen opened (a monotonic count): the top layer stacks modals in the order they opened, so the later one is the topmost. */
  private readonly opened = new WeakMap<Element, number>();
  private count = 0;

  /** `changed(opened)`: a dialog, the reading overlay, the seat or the viewport's width changed; `opened`: a dialog opened. */
  constructor(private readonly changed: (opened: boolean) => void) {
    this.narrow?.addEventListener('change', this.onNarrow);
    if (typeof MutationObserver === 'undefined') return;
    this.watcher = new MutationObserver((records) => {
      // (The whiteboard overlay and the floor overview are divs with `open`, not dialogs: SCREEN lists them.)
      const screen = (r: MutationRecord) => r.target instanceof HTMLDialogElement || (r.target instanceof Element && (r.target.classList.contains('wb') || r.target.classList.contains('ov')));
      // Stamp in the order the changes happened, so a dialog opened over another one is known to be above it.
      for (const r of records) if (r.attributeName === 'open' && r.oldValue === null && r.target instanceof Element && r.target.hasAttribute('open')) this.opened.set(r.target, ++this.count);
      if (!records.some((r) => screen(r) || r.attributeName === 'data-reading' || r.attributeName === 'data-seated')) return;
      this.changed(records.some((r) => r.target instanceof HTMLDialogElement && r.target.open));
    });
    this.watcher.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open', 'data-reading', 'data-seated'], attributeOldValue: true });
  }

  /** A dialog (modal, or the Changes panel) is open, and the viewport is too narrow to sit beside it. */
  get folded(): boolean {
    return !!this.narrow?.matches && !!document.querySelector('dialog[open]');
  }

  /** A screen-filling dialog or the reading overlay is open, or you sit at a laptop. */
  get screen(): boolean {
    return !!document.querySelector(SCREEN) || !!document.querySelector(READING) || !!document.querySelector(SEATED);
  }

  /** The Changes panel takes the right column: the corner moves to its left (limits.css, inbox.css). */
  get beside(): 'changes' | '' {
    return document.querySelector('dialog.changes[open]') ? 'changes' : '';
  }

  /**
   * The open screens from the bottom of the stack to the top. The whiteboard and the overview are plain divs and sit
   * under every modal dialog; the dialogs stack in the order they opened (`opened`). One that opened since the last
   * mutation callback has no stamp yet: it is newer than the stamped ones, and the palette, a modal over anything
   * that was already up, is the newest of those.
   */
  private stack(): Element[] {
    const open = [...document.querySelectorAll(SCREEN)];
    const dialogs = open.filter((e) => e instanceof HTMLDialogElement);
    for (const d of [...dialogs.filter((e) => !e.matches(PALETTE)), ...dialogs.filter((e) => e.matches(PALETTE))]) if (!this.opened.has(d)) this.opened.set(d, ++this.count);
    return [...open.filter((e) => !(e instanceof HTMLDialogElement)), ...dialogs.sort((a, b) => this.opened.get(a)! - this.opened.get(b)!)];
  }

  /** The topmost open screen dialog: the one that opened last (the palette is a modal over any view, but another modal can open over it, e.g. the shortcut list). */
  topScreen(): Element | null {
    return this.stack().pop() ?? null;
  }

  /**
   * The screens the plate's edge tab has to keep clear of: all of them, but with the palette up only the palette and
   * what opened over it (what is under the palette is dimmed behind it, as is the seated laptop's glass).
   */
  clearOf(): Element[] {
    const stack = this.stack();
    const palette = stack.findIndex((e) => e.matches(PALETTE));
    return palette < 0 ? stack : stack.slice(palette);
  }

  /** The palette is open: the plate steps out into the tab beside it (and beside what opened over it). */
  get palette(): boolean {
    return !!document.querySelector(PALETTE);
  }

  dispose(): void {
    this.watcher?.disconnect();
    this.narrow?.removeEventListener('change', this.onNarrow);
  }
}

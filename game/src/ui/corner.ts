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
 * #51 the hire dialog, a near-full-screen sheet): at any viewport width the plate steps out of them. The confirm,
 * start-run, send-home, prompt, presets and open-PR dialogs are small and centred; they keep today's behaviour (the
 * plate stays above them in the top layer, and the start-run one shows the limits inline as well). The hire dialog
 * shows the chosen harness's limits inline too, so nothing is lost when the plate folds away over it.
 */
// M13: the whiteboard overlay (a div, ui/whiteboard.ts) carries `open` while it is up, like a dialog.
export const SCREEN = 'dialog.panel[open], dialog.desk-dlg--board[open], dialog.desk-dlg--item[open], dialog.desk-dlg--hire[open], .wb[open]';

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

  /** `changed(opened)`: a dialog, the reading overlay, the seat or the viewport's width changed; `opened`: a dialog opened. */
  constructor(private readonly changed: (opened: boolean) => void) {
    this.narrow?.addEventListener('change', this.onNarrow);
    if (typeof MutationObserver === 'undefined') return;
    this.watcher = new MutationObserver((records) => {
      // (The whiteboard overlay is a div with `open`, not a dialog: SCREEN lists it.)
      const screen = (r: MutationRecord) => r.target instanceof HTMLDialogElement || (r.target instanceof Element && r.target.classList.contains('wb'));
      if (!records.some((r) => screen(r) || r.attributeName === 'data-reading' || r.attributeName === 'data-seated')) return;
      this.changed(records.some((r) => r.target instanceof HTMLDialogElement && r.target.open));
    });
    this.watcher.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open', 'data-reading', 'data-seated'] });
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

  /** The topmost open screen dialog (the last in the document, where a later one opens). */
  topScreen(): Element | null {
    const dialogs = document.querySelectorAll(SCREEN);
    return dialogs[dialogs.length - 1] ?? null;
  }

  dispose(): void {
    this.watcher?.disconnect();
    this.narrow?.removeEventListener('change', this.onNarrow);
  }
}

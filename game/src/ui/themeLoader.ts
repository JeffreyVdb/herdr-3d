import { canvasFaces, themeById, themeVars, type ThemeId, type ThemePreset } from './themes';
import type { ViewPrefs } from './themePrefs';
import { UI_THEME_ATTR, uiThemeById, type UiThemePreset } from './uiTheme';

/**
 * #59: puts the chosen presets on the page. The transcript's goes on the root element as custom properties at once
 * (its fonts, `--tx-mono` and `--tx-prose`, and colours), and the DOM swaps fonts as they arrive (`font-display:
 * swap`). The terminal's is a canvas, which cannot swap by itself: `ready` fires once the faces it draws with have
 * loaded (or failed: then the system's monospace draws it) and the screens repaint with them.
 *
 * #216: and the application UI theme: one attribute on the root (`data-ui-theme`; its colours and `--font` /
 * `--font-mono` are CSS, ui/uiTheme.css), so a switch restyles every mounted surface at once and touches no DOM, focus
 * or scene. It is applied here in the constructor, and earlier by the inline script in index.html.
 *
 * Fonts load on first use: Quiet's stylesheet comes with the app (`main.ts`), the other is split out by Vite and
 * fetched the first time the UI, the transcript or the terminal picks it (one import, shared). A stylesheet only
 * declares its faces; a file is fetched when text uses it, so the terminal in Ubuntu fetches Ubuntu Mono and never
 * Ubuntu, while Ubuntu UI asks for the faces the shell draws (Ubuntu 400 and 700, Ubuntu Mono 400) at once.
 */

/** Each preset's font stylesheet: a literal import, so Vite splits each one into its own CSS and font files. */
const LOADERS: Record<ThemeId, () => Promise<unknown>> = {
  quiet: () => Promise.resolve(),
  ubuntu: () => import('../fonts/ubuntu.css'),
};

/** The faces Ubuntu UI draws the shell with: its text (regular, and bold for titles and buttons) and its mono. */
const UI_FACES = ['400 14px "Ubuntu"', '700 14px "Ubuntu"', '400 14px "Ubuntu Mono"'] as const;

/** What `document.fonts` offers here (a fake in vitest). */
export interface FontLoader {
  load(font: string, text?: string): Promise<unknown>;
}

export class ThemeLoader {
  private readonly listeners = new Set<(t: ThemePreset) => void>();
  /** The preset the terminal draws with (the previous one while the new one's faces load). */
  private readyTheme: ThemePreset;
  private gen = 0;
  /** Settles when the latest picks' stylesheets and the terminal's faces are in (tests, the e2e hook). */
  loading: Promise<void> = Promise.resolve();
  private transcriptLoad: Promise<unknown> = Promise.resolve();
  private uiLoad: Promise<unknown> = Promise.resolve();
  private terminalLoad: Promise<void> = Promise.resolve();

  constructor(
    readonly prefs: ViewPrefs,
    private readonly root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
    private readonly fonts: FontLoader | null = typeof document === 'undefined' ? null : document.fonts,
  ) {
    this.readyTheme = themeById(prefs.theme('terminal'));
    prefs.onChange((what) => {
      if (what === 'uiTheme') this.applyUi();
      else if (what === 'transcriptTheme') this.applyTranscript();
      else if (what === 'transcriptZoom') this.setVars();
      else if (what === 'terminalTheme') this.applyTerminal();
    });
    this.applyUi();
    this.applyTranscript();
    this.applyTerminal();
  }

  /** #216: the application UI theme's preset. */
  get ui(): UiThemePreset {
    return uiThemeById(this.prefs.uiTheme());
  }

  /** The transcript's preset (its colours and sizes are on the page already). */
  get theme(): ThemePreset {
    return themeById(this.prefs.theme('transcript'));
  }

  /** The terminal's preset as picked. */
  get terminal(): ThemePreset {
    return themeById(this.prefs.theme('terminal'));
  }

  /** The preset the terminal draws with now. */
  get ready(): ThemePreset {
    return this.readyTheme;
  }

  /** Called with the terminal's preset once its faces can draw on a canvas. */
  onReady(fn: (t: ThemePreset) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setVars(): void {
    const t = this.theme;
    if (!this.root) return;
    for (const [k, v] of Object.entries(themeVars(t, this.prefs.zoom('transcript')))) this.root.style.setProperty(k, v);
    this.root.dataset.theme = t.id;
  }

  private settled(): void {
    this.loading = Promise.all([this.uiLoad, this.transcriptLoad, this.terminalLoad]).then(() => undefined);
  }

  private applyUi(): void {
    const t = this.ui;
    if (this.root) {
      this.root.dataset[UI_THEME_ATTR] = t.id;
      // The browser's own chrome (the address bar on a phone) follows the bars.
      this.root.ownerDocument?.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.themeColor);
    }
    // Ubuntu UI: its stylesheet, and the faces the shell draws right away (Quiet's come with the app).
    this.uiLoad = LOADERS[t.id]()
      .then(() => (t.id === 'ubuntu' ? Promise.all(UI_FACES.map((f) => this.fonts?.load(f, 'MW09 Ag'))) : undefined))
      .catch(() => undefined);
    this.settled();
  }

  private applyTranscript(): void {
    this.setVars();
    this.transcriptLoad = LOADERS[this.theme.id]().catch(() => undefined);
    this.settled();
  }

  private applyTerminal(): void {
    const t = this.terminal;
    const gen = ++this.gen;
    // Only the mono faces the canvas draws with: the preset's prose font is not asked for.
    this.terminalLoad = LOADERS[t.id]()
      .then(() => Promise.all(canvasFaces(t).map((f) => this.fonts?.load(f, 'MW09'))))
      .catch(() => undefined)
      .then(() => {
        if (gen !== this.gen) return;
        this.readyTheme = t;
        for (const fn of this.listeners) fn(t);
      });
    this.settled();
  }
}

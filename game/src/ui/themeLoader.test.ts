// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ThemeLoader, type FontLoader } from './themeLoader';
import { ViewPrefs } from './themePrefs';

/** A font set whose loads settle when the test says so. */
function fonts(fail = false) {
  const asked: string[] = [];
  const pending: Array<() => void> = [];
  const f: FontLoader & { asked: string[]; settle(): void } = {
    asked,
    load(font: string) {
      asked.push(font);
      return new Promise((resolve, reject) => pending.push(() => (fail ? reject(new Error('404')) : resolve([]))));
    },
    settle() {
      for (const p of pending.splice(0)) p();
    },
  };
  return f;
}

/** Settles the font loads as they come until the latest picks are in (a stylesheet's import takes a while). */
async function drain(t: ThemeLoader, f: ReturnType<typeof fonts>): Promise<void> {
  let done = false;
  const p = t.loading.then(() => (done = true));
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setTimeout(r, 5));
    f.settle();
  }
  await p;
}

describe('theme loader (#59)', () => {
  it('puts the transcript’s preset on the page at once, and tells the terminal only once its faces loaded', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    const ready: string[] = [];
    t.onReady((p) => ready.push(p.id));
    expect(root.dataset.theme).toBe('quiet');
    expect(root.style.getPropertyValue('--tx-mono')).toContain('JetBrains Mono Variable');
    await drain(t, f);
    expect(ready).toEqual(['quiet']);
    expect(f.asked).toEqual(['400 16px "JetBrains Mono Variable"', '700 16px "JetBrains Mono Variable"', 'italic 400 16px "JetBrains Mono Variable"', 'italic 700 16px "JetBrains Mono Variable"']);

    // The transcript in Ubuntu: the page's colours, fonts (the limits widget's mono too) change; the terminal does not.
    t.prefs.setTheme('transcript', 'ubuntu');
    expect(root.dataset.theme).toBe('ubuntu');
    expect(root.style.getPropertyValue('--tx-bg')).toBe('#300a24');
    expect(root.style.getPropertyValue('--tx-prose')).toContain('"Ubuntu"');
    expect(root.style.getPropertyValue('--tx-mono')).toContain('Ubuntu Mono');
    // #216: the transcript's pick never sets the shell's fonts or its UI theme.
    expect(root.style.getPropertyValue('--font-mono')).toBe('');
    expect(root.style.getPropertyValue('--font')).toBe('');
    expect(root.dataset.uiTheme).toBe('quiet');
    await drain(t, f);
    expect(ready).toEqual(['quiet']);
    expect(t.ready.id).toBe('quiet');
  });

  it('the terminal’s preset loads its mono faces only (never its prose font) and changes nothing on the page', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    await drain(t, f);
    f.asked.length = 0;
    const before = root.getAttribute('style');
    t.prefs.setTheme('terminal', 'ubuntu');
    // The canvas keeps drawing with Quiet's font until Ubuntu Mono is in.
    expect(t.ready.id).toBe('quiet');
    await drain(t, f);
    expect(t.ready.id).toBe('ubuntu');
    expect(f.asked.every((x) => x.endsWith('"Ubuntu Mono"'))).toBe(true);
    expect(f.asked).toHaveLength(4);
    expect(root.getAttribute('style')).toBe(before);
    expect(root.dataset.theme).toBe('quiet');
  });

  it('a later pick wins over one still loading; each view’s zoom changes only its own sizes', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    const ready: string[] = [];
    t.onReady((p) => ready.push(p.id));
    t.prefs.setTheme('terminal', 'ubuntu');
    t.prefs.setTheme('terminal', 'quiet');
    t.prefs.setTheme('terminal', 'ubuntu');
    t.prefs.setTheme('transcript', 'ubuntu');
    await drain(t, f);
    expect(ready).toEqual(['ubuntu']);
    expect(root.style.getPropertyValue('--tx-fs')).toBe('13.5px');
    t.prefs.setZoom('transcript', 200);
    expect(root.style.getPropertyValue('--tx-fs')).toBe('27px');
    expect(root.style.getPropertyValue('--tx-mono-fs')).toBe('28px');
    t.prefs.setZoom('terminal', 70);
    expect(root.style.getPropertyValue('--tx-fs')).toBe('27px');
    t.prefs.setTheme('transcript', 'quiet');
    expect(root.style.getPropertyValue('--tx-mono-fs')).toBe('23px');
    expect(t.prefs.zoom('transcript')).toBe(200);
    expect(ready).toEqual(['ubuntu']);
  });

  it('a font that fails to load still switches the terminal (to the stack’s system faces)', async () => {
    const root = document.createElement('div');
    const f = fonts(true);
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    t.prefs.setTheme('terminal', 'ubuntu');
    await drain(t, f);
    expect(t.ready.id).toBe('ubuntu');
  });

  it('#216: the UI theme is its own attribute on the root, restored at construction, and moves nothing of the transcript or the terminal', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const store = new Map<string, string>([['h3d.theme.ui', 'ubuntu']]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
    const t = new ThemeLoader(new ViewPrefs(storage), root, f);
    // A saved Ubuntu is on the root before anything has loaded: no navy frame.
    expect(root.dataset.uiTheme).toBe('ubuntu');
    expect(root.dataset.theme).toBe('quiet');
    expect(t.ui.id).toBe('ubuntu');
    expect(t.terminal.id).toBe('quiet');
    const before = root.getAttribute('style');
    t.prefs.setUiTheme('quiet');
    expect(root.dataset.uiTheme).toBe('quiet');
    expect(root.dataset.theme).toBe('quiet');
    expect(root.getAttribute('style')).toBe(before);
    t.prefs.setTheme('transcript', 'ubuntu');
    expect(root.dataset.uiTheme).toBe('quiet');
    await drain(t, f);
  });

  it('#216: Ubuntu UI loads the shell’s faces even with Quiet transcript and terminal; Quiet UI alone loads none of them', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    await drain(t, f);
    f.asked.length = 0;
    t.prefs.setUiTheme('ubuntu');
    await drain(t, f);
    expect(f.asked).toEqual(['400 14px "Ubuntu"', '700 14px "Ubuntu"', '400 14px "Ubuntu Mono"']);
    // The terminal-only pick stays the mono faces only (the existing guarantee).
    f.asked.length = 0;
    t.prefs.setUiTheme('quiet');
    t.prefs.setTheme('terminal', 'ubuntu');
    await drain(t, f);
    expect(f.asked.every((x) => x.endsWith('"Ubuntu Mono"'))).toBe(true);
  });

  it('#216: a font that fails still leaves the UI theme applied (fallback faces)', async () => {
    const root = document.createElement('div');
    const f = fonts(true);
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    t.prefs.setUiTheme('ubuntu');
    await drain(t, f);
    expect(root.dataset.uiTheme).toBe('ubuntu');
  });

  it('#216: the browser chrome colour follows the UI theme’s bars', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#1c2540';
    document.head.append(meta);
    const t = new ThemeLoader(new ViewPrefs(null), document.documentElement, fonts());
    t.prefs.setUiTheme('ubuntu');
    expect(meta.content).toBe('#2c001e');
    t.prefs.setUiTheme('quiet');
    expect(meta.content).toBe('#1c2540');
    meta.remove();
    document.documentElement.removeAttribute('data-ui-theme');
  });
});

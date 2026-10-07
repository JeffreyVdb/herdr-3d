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
    expect(root.style.getPropertyValue('--font-mono')).toContain('JetBrains Mono Variable');
    await drain(t, f);
    expect(ready).toEqual(['quiet']);
    expect(f.asked).toEqual(['400 16px "JetBrains Mono Variable"', '700 16px "JetBrains Mono Variable"', 'italic 400 16px "JetBrains Mono Variable"', 'italic 700 16px "JetBrains Mono Variable"']);

    // The transcript in Ubuntu: the page's colours, fonts (the limits widget's mono too) change; the terminal does not.
    t.prefs.setTheme('transcript', 'ubuntu');
    expect(root.dataset.theme).toBe('ubuntu');
    expect(root.style.getPropertyValue('--tx-bg')).toBe('#300a24');
    expect(root.style.getPropertyValue('--tx-prose')).toContain('"Ubuntu"');
    expect(root.style.getPropertyValue('--font-mono')).toContain('Ubuntu Mono');
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
    expect(root.style.getPropertyValue('--tx-mono-fs')).toBe('24px');
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
});

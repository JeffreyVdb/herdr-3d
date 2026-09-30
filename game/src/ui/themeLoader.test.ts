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

/** Settles the font loads as they come until the latest pick is in (its stylesheet's import takes a while). */
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
  it('puts the picked preset on the page at once, and tells the canvas only once its faces loaded', async () => {
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

    t.prefs.theme = 'paper';
    expect(root.dataset.theme).toBe('paper');
    expect(root.style.getPropertyValue('--tx-bg')).toBe('#f2ead8');
    expect(root.style.getPropertyValue('--tx-prose')).toContain('Newsreader');
    // The canvas keeps drawing with Quiet's font until Space Mono is in.
    expect(t.ready.id).toBe('quiet');
    await drain(t, f);
    expect(t.ready.id).toBe('paper');
    expect(ready).toEqual(['quiet', 'paper']);
  });

  it('a later pick wins over one still loading; a zoom changes only the sizes', async () => {
    const root = document.createElement('div');
    const f = fonts();
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    const ready: string[] = [];
    t.onReady((p) => ready.push(p.id));
    t.prefs.theme = 'terminal';
    t.prefs.theme = 'paper';
    await drain(t, f);
    expect(ready).toEqual(['paper']);
    expect(root.style.getPropertyValue('--tx-fs')).toBe('15px');
    t.prefs.zoom = 200;
    expect(root.style.getPropertyValue('--tx-fs')).toBe('30px');
    expect(root.style.getPropertyValue('--tx-mono-fs')).toBe('24px');
    expect(ready).toEqual(['paper']);
    t.prefs.theme = 'terminal';
    expect(root.style.getPropertyValue('--tx-mono-fs')).toBe('22px');
    expect(t.prefs.zoom).toBe(200);
  });

  it('a font that fails to load still switches the canvas (to the stack’s system faces)', async () => {
    const root = document.createElement('div');
    const f = fonts(true);
    const t = new ThemeLoader(new ViewPrefs(null), root, f);
    t.prefs.theme = 'terminal';
    await drain(t, f);
    expect(t.ready.id).toBe('terminal');
  });
});

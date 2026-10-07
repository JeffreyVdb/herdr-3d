// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fullscreenChip } from '../laptop/fullscreen';
import { SeatBar } from './seat';
import { ViewPrefs } from './themePrefs';

const noop = { text() {}, paste() {}, stand() {}, toggle() {} };

describe('seat bar: the terminal’s preset and zoom (#59)', () => {
  it('a radio group of the two presets and A− / level / A+, for the terminal only', () => {
    const hud = document.createElement('div');
    const prefs = new ViewPrefs(null);
    const bar = new SeatBar(hud, noop, prefs);
    const group = hud.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Terminal theme');
    const radios = [...hud.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked'), r.tabIndex])).toEqual([
      ['Ubuntu', 'false', -1],
      ['Quiet', 'true', 0],
    ]);
    radios[0]!.click();
    expect([prefs.theme('terminal'), prefs.theme('transcript')]).toEqual(['ubuntu', 'quiet']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    // Arrows move and pick, and stay out of the game and the pane.
    let reached = 0;
    hud.addEventListener('keydown', () => reached++);
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(prefs.theme('terminal')).toBe('quiet');
    expect(reached).toBe(0);
    // The zoom: its level always shown, steps of 10, reset on the middle one; the transcript's zoom stays.
    const zoom = hud.querySelector('[aria-label="Terminal text size"]') as HTMLElement;
    const [out, level, inc] = [...zoom.querySelectorAll<HTMLButtonElement>('button')];
    expect(level!.textContent).toBe('100%');
    inc!.click();
    inc!.click();
    expect(level!.textContent).toBe('120%');
    expect(bar.summary().terminalZoom).toBe('120%');
    level!.click();
    for (let i = 0; i < 9; i++) out!.click();
    expect(prefs.zoom('terminal')).toBe(70);
    expect(out!.disabled).toBe(true);
    expect(prefs.zoom('transcript')).toBe(100);
    // Set elsewhere (the keys), shown here.
    prefs.setZoom('terminal', 150);
    expect(level!.textContent).toBe('150%');
    // Its controls own their keys; the hidden keyboard for the pane does not count as one.
    expect(bar.owns(radios[0]!)).toBe(true);
    expect(bar.owns(bar.input)).toBe(false);
    expect(bar.owns(document.body)).toBe(false);
  });

  it('Ctrl+, lands on the picked preset (the label says so); Esc from the controls hands the keyboard back', () => {
    const hud = document.createElement('div');
    document.body.append(hud);
    const prefs = new ViewPrefs(null);
    prefs.setTheme('terminal', 'ubuntu');
    const bar = new SeatBar(hud, noop, prefs);
    bar.show('Tofu', false);
    bar.focus();
    const label = hud.querySelector('.seat-look-label') as HTMLElement;
    expect([...label.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', ',']);
    const group = hud.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-keyshortcuts')).toBe('Control+,');
    expect(bar.focusLook()).toBe(true);
    const ubuntu = hud.querySelector('[data-theme-id="ubuntu"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(ubuntu);
    expect(bar.inLook(ubuntu)).toBe(true);
    expect(bar.inLook(hud.querySelector('.seat-stand'))).toBe(false);
    expect(bar.inLook(bar.input)).toBe(false);
    // Back to the pane's keyboard.
    bar.focus();
    expect(document.activeElement).toBe(bar.input);
    hud.remove();
  });

  it('without prefs (an older host), no controls', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    expect(hud.querySelector('.seat-look')).toBeNull();
    expect(bar.focusLook()).toBe(false);
  });
});

describe('seat bar: the fullscreen chip (#74)', () => {
  const chipOf = (hud: HTMLElement) => hud.querySelector<HTMLButtonElement>('.seat-fs')!;

  it('is hidden until there is something to say, then states the fact and is a toggle', () => {
    const hud = document.createElement('div');
    const asked: string[] = [];
    const bar = new SeatBar(hud, { ...noop, fullscreen: (a: string) => asked.push(a) }, new ViewPrefs(null));
    const chip = chipOf(hud);
    expect(chip.hidden).toBe(true);
    expect(bar.summary().fullscreen).toBeNull();

    bar.setFullscreen(fullscreenChip({ state: 'split', applied: false }, { cols: 60, rows: 40 }));
    expect(chip.hidden).toBe(false);
    expect(bar.summary().fullscreen).toEqual({ label: 'Split pane 60×40', pressed: false, unavailable: false });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.getAttribute('aria-label')).toBe('Fullscreen, off. Split pane 60 by 40');
    chip.click();

    bar.setFullscreen(fullscreenChip({ state: 'zoomed', applied: true }, { cols: 131, rows: 47 }));
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(bar.summary().fullscreen?.label).toBe('Fullscreen');
    chip.click();
    expect(asked).toEqual(['zoom', 'unzoom']);

    // A zoom that could not widen the pane: its words stay, it does nothing and is marked aria-disabled, still focusable.
    bar.setFullscreen(fullscreenChip({ state: 'zoomed', applied: true, headless: true }, { cols: 120, rows: 40 }));
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.disabled).toBe(false);
    expect(bar.summary().fullscreen).toEqual({ label: 'Fullscreen unavailable', pressed: false, unavailable: true });
    chip.click();
    expect(asked).toHaveLength(2);

    bar.setFullscreen(null);
    expect(chip.hidden).toBe(true);
  });

  it('is one of the bar’s controls: it owns its keys, and Ctrl+, reaches the controls it sits with', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop, new ViewPrefs(null));
    bar.setFullscreen(fullscreenChip({ state: 'split', applied: false }, { cols: 60, rows: 40 }));
    const chip = chipOf(hud);
    expect(bar.owns(chip)).toBe(true);
    expect(bar.inLook(chip)).toBe(true);
    // After the swatches and the zoom, in Tab order.
    const order = [...hud.querySelectorAll('.seat-look button')];
    expect(order.at(-1)).toBe(chip);
  });
});


describe('seat bar: the worker’s own Codex server (#155)', () => {
  it('a line in the question’s place that says what to do, gone when there is nothing to say', () => {
    const hud = document.createElement('div');
    const bar = new SeatBar(hud, noop);
    const line = hud.querySelector('.seat-codex') as HTMLElement;
    const seat = hud.querySelector('.seat') as HTMLElement;
    expect(line.hidden).toBe(true);
    bar.codexNote({ tone: 'down', text: 'Its Codex server stopped: the terminal is waiting to reconnect.' });
    expect(line.hidden).toBe(false);
    expect(seat.hasAttribute('data-codex')).toBe(true);
    expect(line.dataset.tone).toBe('down');
    expect(line.textContent).toBe('Codex serverIts Codex server stopped: the terminal is waiting to reconnect.');
    expect(line.getAttribute('role')).toBe('status');
    bar.codexNote(null);
    expect(line.hidden).toBe(true);
    expect(seat.hasAttribute('data-codex')).toBe(false);
  });
});

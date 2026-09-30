// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SeatBar } from './seat';
import { ViewPrefs } from './themePrefs';

const noop = { text() {}, paste() {}, stand() {}, toggle() {} };

describe('seat bar: the terminal’s preset and zoom (#59)', () => {
  it('a radio group of the three presets and A− / level / A+, for the terminal only', () => {
    const hud = document.createElement('div');
    const prefs = new ViewPrefs(null);
    const bar = new SeatBar(hud, noop, prefs);
    const group = hud.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Terminal theme');
    const radios = [...hud.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked'), r.tabIndex])).toEqual([
      ['Terminal', 'false', -1],
      ['Quiet', 'true', 0],
      ['Paper', 'false', -1],
    ]);
    radios[2]!.click();
    expect([prefs.theme('terminal'), prefs.theme('transcript')]).toEqual(['paper', 'quiet']);
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    // Arrows move and pick, and stay out of the game and the pane.
    let reached = 0;
    hud.addEventListener('keydown', () => reached++);
    radios[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(prefs.theme('terminal')).toBe('terminal');
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

  it('without prefs (an older host), no controls', () => {
    const hud = document.createElement('div');
    new SeatBar(hud, noop);
    expect(hud.querySelector('.seat-look')).toBeNull();
  });
});

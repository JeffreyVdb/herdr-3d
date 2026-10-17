// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hud } from './hud';

// #64 schedules: a toast can carry an action: a click on it (or its button) runs it and hides it. A plain toast, and
// one that has gone, takes no click.

describe('Hud.toast with an action (#64 schedules)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('runs the action once on a click and hides; a plain toast after it is no control', () => {
    const hud = new Hud(document.body);
    const el = document.querySelector<HTMLElement>('.toast')!;
    const ran: string[] = [];
    hud.toast('Scheduled agent “Soak” started 3h late.', 9000, 'warn', false, { label: 'Show', run: () => ran.push('a') });
    expect(hud.toastState()).toEqual({ shown: true, text: 'Scheduled agent “Soak” started 3h late.', kind: 'warn', action: 'Show' });
    expect(el.dataset.action).toBe('true');
    const b = el.querySelector<HTMLButtonElement>('.toast-act')!;
    expect(b.textContent).toBe('Show');
    b.click();
    expect(ran).toEqual(['a']);
    expect(el.hidden).toBe(true);
    expect(el.dataset.action).toBeUndefined();
    el.click();
    expect(ran).toEqual(['a']);
    hud.toast('Saved.', 3000);
    expect(el.dataset.action).toBeUndefined();
    expect(el.querySelector('.toast-act')).toBeNull();
    el.click();
    expect(ran).toEqual(['a']);
  });

  it('an action toast that times out takes no click', () => {
    const hud = new Hud(document.body);
    const el = document.querySelector<HTMLElement>('.toast')!;
    const ran: string[] = [];
    hud.toast('Failed.', 1000, 'error', false, { label: 'Show', run: () => ran.push('x') });
    vi.advanceTimersByTime(1001);
    expect(el.hidden).toBe(true);
    el.click();
    expect(ran).toEqual([]);
    expect(hud.toastState().action).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onPlayerAct } from './hireGoto';

const flush = () => new Promise<void>((r) => setTimeout(r, 0)); // (mutation records are delivered as a microtask)

afterEach(() => void (document.body.innerHTML = ''));

describe('onPlayerAct', () => {
  it('hears keys, presses and the wheel, before anything else on the page does', () => {
    const act = vi.fn();
    const stop = onPlayerAct(act);
    const input = document.body.appendChild(document.createElement('input'));
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
    expect(act).toHaveBeenCalledTimes(3);
    stop();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(act).toHaveBeenCalledTimes(3);
  });

  it('#116 R2: hears a dialog that opened and closed again before anyone looked', async () => {
    const d = document.body.appendChild(document.createElement('dialog'));
    const act = vi.fn();
    const stop = onPlayerAct(act);
    d.setAttribute('open', '');
    d.removeAttribute('open');
    await flush();
    expect(act).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not take a dialog closing for the player acting (the hire dialog shuts just as the ack comes)', async () => {
    const d = document.body.appendChild(document.createElement('dialog'));
    d.setAttribute('open', '');
    const act = vi.fn();
    const stop = onPlayerAct(act);
    d.removeAttribute('open');
    await flush();
    expect(act).not.toHaveBeenCalled();
    stop();
  });

  it('ignores other elements taking an open attribute', async () => {
    const det = document.body.appendChild(document.createElement('details'));
    const act = vi.fn();
    const stop = onPlayerAct(act);
    det.setAttribute('open', '');
    await flush();
    expect(act).not.toHaveBeenCalled();
    stop();
  });
});

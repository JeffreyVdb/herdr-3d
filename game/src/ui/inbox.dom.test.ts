// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxChip } from './inbox';

const tick = () => new Promise((r) => setTimeout(r, 0));

function mount(plateHeight = 40): { chip: InboxChip; go: ReturnType<typeof vi.fn>; plate: HTMLElement } {
  const plate = document.createElement('aside');
  // jsdom has no layout: the plate is as tall as the test says.
  plate.getBoundingClientRect = () => ({ left: 900, top: 72, right: 1268, bottom: 72 + plateHeight, width: plateHeight ? 368 : 0, height: plateHeight, x: 900, y: 72, toJSON: () => ({}) });
  document.body.append(plate);
  const go = vi.fn();
  const chip = new InboxChip(document.body, plate, go);
  return { chip, go, plate };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-seated');
});

describe('InboxChip', () => {
  it('is not there at zero', () => {
    const { chip } = mount();
    expect(chip.root.hidden).toBe(true);
    chip.set(null);
    expect(chip.summary()).toEqual({ shown: false, count: 0, blocked: false });
  });

  it('says Inbox and the count, red only while someone needs you', () => {
    const { chip } = mount();
    chip.set({ count: 3, blocked: true });
    expect(chip.root.hidden).toBe(false);
    expect(chip.root.textContent).toBe('Inbox3');
    expect(chip.root.dataset.blocked).toBe('true');
    expect(chip.root.getAttribute('aria-label')).toBe('Inbox: 3, someone needs you. Sit at the first one’s laptop.');
    chip.set({ count: 1, blocked: false });
    expect(chip.root.textContent).toBe('Inbox1');
    expect(chip.root.dataset.blocked).toBe('false');
    chip.set(null);
    expect(chip.root.hidden).toBe(true);
  });

  it('a click goes', () => {
    const { chip, go } = mount();
    chip.set({ count: 2, blocked: false });
    chip.root.click();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('sits under the plate, or in its spot when the plate is not drawn', () => {
    expect(mount(40).chip.root.style.getPropertyValue('--ib-lift')).toBe('46.0px');
    expect(mount(0).chip.root.style.getPropertyValue('--ib-lift')).toBe('0px');
  });

  it('goes away at a laptop and over a screen dialog, and comes back after', async () => {
    const { chip } = mount();
    chip.set({ count: 1, blocked: true });
    document.documentElement.setAttribute('data-seated', '1200');
    await tick();
    expect(chip.root.hidden).toBe(true);
    document.documentElement.removeAttribute('data-seated');
    await tick();
    expect(chip.root.hidden).toBe(false);
    const d = document.createElement('dialog');
    d.className = 'panel';
    document.body.append(d);
    d.setAttribute('open', '');
    await tick();
    expect(chip.root.hidden).toBe(true);
    d.removeAttribute('open');
    await tick();
    expect(chip.root.hidden).toBe(false);
  });

  it('stays beside a small dialog on a wide screen, and moves left of the Changes panel', async () => {
    const { chip } = mount();
    chip.set({ count: 1, blocked: false });
    const small = document.createElement('dialog');
    small.className = 'confirm';
    document.body.append(small);
    small.setAttribute('open', '');
    await tick();
    expect(chip.root.hidden).toBe(false);
    small.remove();
    const changes = document.createElement('dialog');
    changes.className = 'changes';
    document.body.append(changes);
    changes.setAttribute('open', '');
    await tick();
    expect(chip.root.dataset.beside).toBe('changes');
  });
});

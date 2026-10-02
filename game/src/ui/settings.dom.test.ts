// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './settings';

function make(): SettingsDialog {
  document.body.replaceChildren();
  return new SettingsDialog(document.body);
}

const sections = () => [...document.querySelectorAll<HTMLElement>('.settings-section')];

describe('SettingsDialog section registry (#91)', () => {
  it('renders each section under its own h3 and a label of where it is kept, in the order added', () => {
    const s = make();
    s.addSection('a', 'First', (body) => void body.append('one'), { store: 'browser' });
    s.addSection('b', 'Second', (body) => void body.append('two'), { store: 'bridge' });
    expect(s.sectionIds).toEqual(['a', 'b']);
    const [a, b] = sections();
    expect(a!.querySelector('h3')!.textContent).toBe('First');
    expect(a!.querySelector('.settings-store')!.textContent).toBe('This browser');
    expect(a!.querySelector('.settings-content')!.textContent).toBe('one');
    expect(b!.querySelector('h3')!.textContent).toBe('Second');
    expect(b!.querySelector('.settings-store')!.textContent).toBe('Bridge');
    // The section is named by its heading for assistive tech.
    expect(b!.getAttribute('aria-labelledby')).toBe(b!.querySelector('h3')!.id);
  });

  it('refuses a second section with the same id', () => {
    const s = make();
    s.addSection('a', 'First', () => {}, { store: 'browser' });
    expect(() => s.addSection('a', 'Again', () => {}, { store: 'browser' })).toThrow(/already added/);
    expect(sections()).toHaveLength(1);
  });

  it('removing a section drops its element and disposes it; dispose disposes the rest', () => {
    const s = make();
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const removeA = s.addSection('a', 'A', () => ({ dispose: disposeA }), { store: 'browser' });
    s.addSection('b', 'B', () => ({ dispose: disposeB }), { store: 'bridge' });
    removeA();
    removeA();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(s.sectionIds).toEqual(['b']);
    expect(sections()).toHaveLength(1);
    s.dispose();
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('is a dialog that only Esc and the close button dismiss: the backdrop policy is none', () => {
    make();
    const d = document.querySelector('dialog')!;
    expect(d.getAttribute('closedby')).toBe('closerequest');
    expect(d.getAttribute('aria-labelledby')).toBe(d.querySelector('h2')!.id);
  });

  it('a section can hide itself, heading and all; reveal skips it while hidden (#98)', () => {
    const s = make();
    let hide: (h: boolean) => void = () => {};
    s.addSection('a', 'A', () => {}, { store: 'browser' });
    s.addSection('b', 'B', (_body, section) => void (hide = section.setHidden), { store: 'bridge' });
    hide(true);
    const b = sections()[1]!;
    expect(b.hidden).toBe(true);
    expect(s.sectionIds).toEqual(['a', 'b']);
    s.reveal('b');
    expect(document.activeElement).not.toBe(b.querySelector('h3'));
    hide(false);
    expect(b.hidden).toBe(false);
    b.scrollIntoView = () => {};
    s.reveal('b');
    expect(document.activeElement).toBe(b.querySelector('h3'));
  });

  it('calls a section’s open hook each time the dialog opens', () => {
    const s = make();
    const open = vi.fn();
    s.addSection('a', 'A', () => ({ open }), { store: 'browser' });
    const d = document.querySelector('dialog')!;
    d.showModal = vi.fn(() => void d.setAttribute('open', ''));
    s.open();
    expect(open).toHaveBeenCalledTimes(1);
    expect(s.isOpen).toBe(true);
  });
});

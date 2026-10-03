// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BINDINGS, GROUPS, groupsOf, type Binding } from '../input/shortcuts';
import { typingIn } from '../input/typing';
import { ShortcutsDialog } from './shortcutsDialog';

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the game's code looks at.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => void (document.body.innerHTML = ''));

describe('the ? reference dialog (#124)', () => {
  it('draws every binding under the groups it belongs to, with the title and region a screen reader needs', () => {
    const d = new ShortcutsDialog(document.body);
    d.open(null);
    const dlg = document.querySelector('dialog.shortcuts') as HTMLDialogElement;
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(dlg.getAttribute('aria-labelledby')).toBe('shortcuts-title');
    expect(document.getElementById('shortcuts-title')?.textContent).toBe('Keyboard shortcuts');
    expect(dlg.querySelector('[role="region"]')?.getAttribute('aria-label')).toBeTruthy();
    const groups = [...dlg.querySelectorAll('section.sc-group')];
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual(GROUPS.map((g) => g.title));
    for (const g of groups) expect(document.getElementById(g.getAttribute('aria-labelledby') ?? '')).toBe(g.querySelector('h3'));
    GROUPS.forEach((g, i) => {
      const labels = [...(groups[i] as Element).querySelectorAll('dt')].map((x) => x.textContent);
      const want = (BINDINGS as readonly Binding[]).filter((b) => groupsOf(b).includes(g.id)).map((b) => b.label);
      expect(labels).toEqual(want);
    });
    // Each row pairs what it does with its keys, in `<kbd>`s.
    for (const row of dlg.querySelectorAll('.sc-row')) {
      expect(row.querySelector('dt')?.textContent?.length).toBeGreaterThan(3);
      expect(row.querySelectorAll('dd kbd').length).toBeGreaterThan(0);
    }
    // The seated group says how to get help from a seat, and the intro says single keys pause in fields.
    expect(dlg.textContent).toContain('Esc stands you up; then ? opens this list.');
    expect(dlg.querySelector('.sc-intro')?.textContent).toMatch(/pause the moment a text field has it/);
    expect([...dlg.querySelectorAll('.sc-intro kbd')].map((k) => k.textContent)).toEqual([expect.stringMatching(/^(Ctrl|⌘)$/), '/']);
  });

  it('says ⌘ on a Mac and Ctrl elsewhere', () => {
    const was = Object.getOwnPropertyDescriptor(navigator, 'platform');
    for (const [platform, cap] of [['MacIntel', '⌘'], ['Linux x86_64', 'Ctrl']] as const) {
      Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
      const d = new ShortcutsDialog(document.body);
      d.open(null);
      const row = [...document.querySelectorAll('.sc-row')].find((r) => r.textContent?.includes('from inside a text field'));
      expect([...(row?.querySelectorAll('dd kbd') ?? [])].map((k) => k.textContent)).toEqual([cap, '/']);
      d.dispose();
    }
    if (was) Object.defineProperty(navigator, 'platform', was);
    else delete (navigator as unknown as { platform?: string }).platform;
  });

  it('closes, and hands the focus back to where it was', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const d = new ShortcutsDialog(document.body);
    opener.focus();
    d.open(opener);
    expect(d.isOpen).toBe(true);
    (document.querySelector('.panel-close') as HTMLButtonElement).click();
    expect(d.isOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
    // Opened twice, drawn once; its keys never reach the game behind.
    d.open(opener);
    d.open(opener);
    expect(document.querySelectorAll('section.sc-group').length).toBe(GROUPS.length);
    let seen = false;
    window.addEventListener('keydown', () => (seen = true), { once: true });
    document.querySelector('dialog.shortcuts')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    expect(seen).toBe(false);
  });
});

// (jsdom has no `contentEditable` property: the attribute is what the game's check reads there.)
const editable = (e: HTMLElement): HTMLElement => (e.setAttribute('contenteditable', 'true'), e);

describe('typingIn: every kind of field keeps its keys (#124)', () => {
  const fields: Array<[string, () => HTMLElement]> = [
    ['text input', () => Object.assign(document.createElement('input'), { type: 'text' })],
    ['search input', () => Object.assign(document.createElement('input'), { type: 'search' })],
    ['number input', () => Object.assign(document.createElement('input'), { type: 'number' })],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    ['contenteditable', () => editable(document.createElement('div'))],
    ['a child of a contenteditable', () => {
      const root = editable(document.createElement('div'));
      const span = document.createElement('span');
      root.append(span);
      document.body.append(root);
      return span;
    }],
    ['role=textbox', () => document.createElement('div')],
    ['role=combobox', () => document.createElement('div')],
    ['role=searchbox', () => document.createElement('div')],
  ];
  for (const [name, make] of fields) {
    it(name, () => {
      const el = make();
      if (name.startsWith('role=')) el.setAttribute('role', name.slice(5));
      if (!el.isConnected) document.body.append(el);
      expect(typingIn(el)).toBe(true);
    });
  }
  it('is not a button, a link, the page or nothing', () => {
    for (const el of [document.createElement('button'), document.createElement('a'), document.createElement('div'), document.body]) expect(typingIn(el)).toBe(false);
    const off = document.createElement('div');
    off.setAttribute('contenteditable', 'false');
    expect(typingIn(off)).toBe(false);
    expect(typingIn(null)).toBe(false);
    expect(typingIn(window)).toBe(false);
  });
});

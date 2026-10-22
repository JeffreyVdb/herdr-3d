// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type SettingsGroup, SettingsDialog } from './settings';

function make(): SettingsDialog {
  document.body.replaceChildren();
  const s = new SettingsDialog(document.body);
  const d = document.querySelector('dialog')!;
  d.showModal = vi.fn(() => void d.setAttribute('open', ''));
  d.close = vi.fn(() => {
    d.removeAttribute('open');
    d.dispatchEvent(new Event('close'));
  });
  return s;
}

const sections = () => [...document.querySelectorAll<HTMLElement>('.settings-section')];
const panel = (id: string) => document.querySelector<HTMLElement>(`.settings-section[data-section="${id}"]`)!;
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${id}"]`)!;
const tablist = () => document.querySelector<HTMLElement>('[role="tablist"]')!;
const picker = () => document.querySelector<HTMLSelectElement>('select.settings-pick-select')!;
/** The tabs a keyboard or screen reader can reach, in the order they show. */
const shownTabs = () => [...tablist().querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hidden).map((t) => t.dataset.tab);
/** The picker's choices, by group: what the narrow layout offers. */
const pickerGroups = () =>
  [...picker().querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].filter((o) => !o.hidden).map((o) => o.value)]);
const key = (el: HTMLElement, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

/** Sections a..e: a, b in General, c in AI, d, e in Workers (registered out of the navigator's order). */
function five(s: SettingsDialog, groups: Record<string, SettingsGroup> = { a: 'general', b: 'general', c: 'ai', d: 'workers', e: 'workers' }) {
  const hide: Record<string, (h: boolean) => void> = {};
  for (const [id, group] of Object.entries(groups)) {
    s.addSection(
      id,
      id.toUpperCase(),
      (body, section) => {
        hide[id] = section.setHidden;
        const input = document.createElement('input');
        input.setAttribute('aria-label', `${id} field`);
        body.append(input);
      },
      { store: 'browser', group },
    );
  }
  return hide;
}

describe('SettingsDialog section registry (#91)', () => {
  it('renders each section under its own h3 and a label of where it is kept, in the order added', () => {
    const s = make();
    s.addSection('a', 'First', (body) => void body.append('one'), { store: 'browser', group: 'general' });
    s.addSection('b', 'Second', (body) => void body.append('two'), { store: 'bridge', group: 'general' });
    expect(s.sectionIds).toEqual(['a', 'b']);
    s.open(); // #146: the content renders on the first open
    const [a, b] = sections();
    expect(a!.querySelector('h3')!.textContent).toBe('First');
    expect(a!.querySelector('.settings-store')!.textContent).toBe('This browser');
    expect(a!.querySelector('.settings-content')!.textContent).toBe('one');
    expect(b!.querySelector('h3')!.textContent).toBe('Second');
    expect(b!.querySelector('.settings-store')!.textContent).toBe('Bridge');
  });

  it('refuses a second section with the same id, and a section without a navigator group', () => {
    const s = make();
    s.addSection('a', 'First', () => {}, { store: 'browser', group: 'general' });
    expect(() => s.addSection('a', 'Again', () => {}, { store: 'browser', group: 'general' })).toThrow(/already added/);
    expect(() => s.addSection('x', 'Lost', () => {}, { store: 'browser' } as never)).toThrow(/no navigator group/);
    expect(() => s.addSection('y', 'Lost', () => {}, { store: 'browser', group: 'misc' as SettingsGroup })).toThrow(/no navigator group/);
    expect(sections()).toHaveLength(1);
    expect(shownTabs()).toEqual(['a']);
  });

  it('removing a section drops its panel, tab and choice and disposes it; dispose disposes the rest', () => {
    const s = make();
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const removeA = s.addSection('a', 'A', () => ({ dispose: disposeA }), { store: 'browser', group: 'general' });
    s.addSection('b', 'B', () => ({ dispose: disposeB }), { store: 'bridge', group: 'ai' });
    s.open(); // #146: rendered (a section never rendered has nothing to dispose)
    s.close();
    expect(s.activeSection).toBe('a');
    removeA();
    removeA();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(s.sectionIds).toEqual(['b']);
    expect(sections()).toHaveLength(1);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(picker().querySelectorAll('option')).toHaveLength(1);
    // The removed section was the one showing: the one left takes over.
    expect(s.activeSection).toBe('b');
    expect(panel('b').hidden).toBe(false);
    s.dispose();
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('removing the only section leaves none showing, and the next one added shows', () => {
    const s = make();
    const removeA = s.addSection('a', 'A', () => {}, { store: 'browser', group: 'general' });
    removeA();
    expect(s.activeSection).toBeNull();
    expect(picker().closest<HTMLElement>('.settings-pick')!.hidden).toBe(true);
    s.addSection('b', 'B', () => {}, { store: 'browser', group: 'general' });
    expect(s.activeSection).toBe('b');
    expect(panel('b').hidden).toBe(false);
    expect(document.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);
  });

  it('is a dialog that only Esc and the close button dismiss: the backdrop policy is none', () => {
    make();
    const d = document.querySelector('dialog')!;
    expect(d.getAttribute('closedby')).toBe('closerequest');
    expect(d.getAttribute('aria-labelledby')).toBe(d.querySelector('h2')!.id);
  });

  it('keeps its keys from the game, but Shift+L outside a text field goes on to the plan limits peek (#47)', () => {
    const s = make();
    five(s);
    s.open();
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(`${e.shiftKey ? 'Shift+' : ''}${e.code}`);
    window.addEventListener('keydown', onWindow);
    const press = (el: HTMLElement, code: string, shiftKey = false) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { code, key: shiftKey ? code.slice(3) : code.slice(3).toLowerCase(), shiftKey, bubbles: true, cancelable: true }));
    try {
      const close = document.querySelector<HTMLElement>('.panel-close')!;
      press(tab('a'), 'KeyL', true);
      press(close, 'KeyL', true);
      expect(seen).toEqual(['Shift+KeyL', 'Shift+KeyL']);
      seen.length = 0;
      press(panel('a').querySelector('input')!, 'KeyL', true); // typed into the field
      press(tab('a'), 'KeyL'); // the elevator
      press(close, 'KeyF', true);
      press(tab('a'), 'KeyW');
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('calls a section’s open hook each time the dialog opens, and never on a switch', () => {
    const s = make();
    const openA = vi.fn();
    const openB = vi.fn();
    s.addSection('a', 'A', () => ({ open: openA }), { store: 'browser', group: 'general' });
    s.addSection('b', 'B', () => ({ open: openB }), { store: 'browser', group: 'general' });
    s.open();
    expect(openA).toHaveBeenCalledTimes(1);
    expect(openB).toHaveBeenCalledTimes(1);
    expect(s.isOpen).toBe(true);
    tab('b').click();
    tab('a').click();
    key(tab('a'), 'ArrowDown');
    expect(openA).toHaveBeenCalledTimes(1);
    expect(openB).toHaveBeenCalledTimes(1);
  });
});

describe('the section navigator (#49)', () => {
  it('lists the groups General, Workers, AI, Integrations whatever the registration order, sections in the order added', () => {
    const s = make();
    five(s);
    s.addSection('f', 'F', () => {}, { store: 'bridge', group: 'integrations' });
    expect(shownTabs()).toEqual(['a', 'b', 'd', 'e', 'c', 'f']);
    const labels = [...tablist().querySelectorAll<HTMLElement>('.settings-nav-label')].filter((l) => !l.closest('[hidden]')).map((l) => l.textContent);
    expect(labels).toEqual(['General', 'Workers', 'AI', 'Integrations']);
    expect(pickerGroups()).toEqual([
      ['General', ['a', 'b']],
      ['Workers', ['d', 'e']],
      ['AI', ['c']],
      ['Integrations', ['f']],
    ]);
    // A group with nothing in it is not shown at all.
    const s2 = make();
    s2.addSection('a', 'A', () => {}, { store: 'browser', group: 'ai' });
    expect([...tablist().querySelectorAll<HTMLElement>('.settings-nav-group')].filter((g) => !g.hidden).map((g) => g.dataset.group)).toEqual(['ai']);
    expect(pickerGroups()).toEqual([['AI', ['a']]]);
  });

  it('is a named vertical tablist of tabs bound to their panels; group labels are not tabs', () => {
    const s = make();
    five(s);
    const list = tablist();
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(list.getAttribute('aria-label')).toBe('Settings sections');
    for (const l of list.querySelectorAll('.settings-nav-label')) expect(l.getAttribute('aria-hidden')).toBe('true');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const t = tab(id);
      const p = panel(id);
      expect(t.textContent).toBe(id.toUpperCase());
      expect(t.getAttribute('aria-controls')).toBe(p.id);
      expect(p.getAttribute('role')).toBe('tabpanel');
      expect(p.getAttribute('aria-labelledby')).toBe(t.id);
    }
    // The picker is labelled for the narrow layout.
    expect(picker().labels?.[0]?.textContent).toBe('Section');
  });

  it('shows one section at a time: the first in the navigator until another is chosen, by tab or by picker', () => {
    const s = make();
    five(s);
    s.open();
    expect(s.activeSection).toBe('a');
    const state = () => sections().map((p) => `${p.dataset.section}:${p.hidden ? '-' : '+'}`).join(' ');
    expect(state()).toBe('a:+ b:- c:- d:- e:-');
    expect(tab('a').getAttribute('aria-selected')).toBe('true');
    expect(tab('a').tabIndex).toBe(0);
    expect(tab('c').getAttribute('aria-selected')).toBe('false');
    expect(tab('c').tabIndex).toBe(-1);
    expect(picker().value).toBe('a');

    tab('c').click();
    expect(state()).toBe('a:- b:- c:+ d:- e:-');
    expect([tab('a').tabIndex, tab('c').tabIndex]).toEqual([-1, 0]);
    expect(picker().value).toBe('c');

    picker().value = 'd';
    picker().dispatchEvent(new Event('change', { bubbles: true }));
    expect(s.activeSection).toBe('d');
    expect(state()).toBe('a:- b:- c:- d:+ e:-');
    expect(tab('d').getAttribute('aria-selected')).toBe('true');
  });

  it('Up and Down move along the tabs and wrap, Home and End go to the ends; each selects and focuses', () => {
    const s = make();
    five(s);
    s.open();
    tab('a').focus();
    expect(key(tab('a'), 'ArrowDown').defaultPrevented).toBe(true);
    expect([s.activeSection, document.activeElement]).toEqual(['b', tab('b')]);
    key(tab('b'), 'ArrowDown');
    // Navigator order: General a b, Workers d e, AI c.
    expect([s.activeSection, document.activeElement]).toEqual(['d', tab('d')]);
    key(tab('d'), 'End');
    expect([s.activeSection, document.activeElement]).toEqual(['c', tab('c')]);
    key(tab('c'), 'ArrowDown');
    expect([s.activeSection, document.activeElement]).toEqual(['a', tab('a')]);
    key(tab('a'), 'ArrowUp');
    expect([s.activeSection, document.activeElement]).toEqual(['c', tab('c')]);
    key(tab('c'), 'Home');
    expect([s.activeSection, document.activeElement]).toEqual(['a', tab('a')]);
    // Other keys are left alone (Tab moves on into the panel).
    expect(key(tab('a'), 'Tab').defaultPrevented).toBe(false);
    expect(s.activeSection).toBe('a');
  });

  it('keeps every section’s DOM across switches: a typed draft is still there on the way back', () => {
    const s = make();
    five(s);
    s.open();
    const field = panel('a').querySelector('input')!;
    field.value = 'half typed';
    tab('c').click();
    tab('e').click();
    tab('a').click();
    expect(panel('a').querySelector('input')).toBe(field);
    expect(field.value).toBe('half typed');
  });

  it('remembers each section’s scroll position, and which section was open for the next open', () => {
    const s = make();
    five(s);
    s.open();
    const body = document.querySelector<HTMLElement>('.settings-body')!;
    body.scrollTop = 120;
    tab('c').click();
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 40;
    tab('a').click();
    expect(body.scrollTop).toBe(120);
    tab('c').click();
    expect(body.scrollTop).toBe(40);
    s.close();
    s.open();
    expect(s.activeSection).toBe('c');
    expect(panel('c').hidden).toBe(false);
    expect(document.activeElement).toBe(body);
  });

  it('reveal opens the target over the remembered section, at its top, with the keyboard on its heading', () => {
    const s = make();
    five(s);
    s.open();
    tab('c').click();
    s.close();
    const body = document.querySelector<HTMLElement>('.settings-body')!;
    // What the Hire dialog's link does: open (which restores c), then reveal.
    s.open();
    s.reveal('e');
    body.scrollTop = 300;
    tab('a').click();
    s.reveal('e');
    expect(s.activeSection).toBe('e');
    expect(panel('e').hidden).toBe(false);
    expect(body.scrollTop).toBe(0);
    expect(document.activeElement).toBe(panel('e').querySelector('h3'));
    expect(tab('e').tabIndex).toBe(0);
    // And it stays the remembered one.
    s.close();
    s.open();
    expect(s.activeSection).toBe('e');
    // Unknown ids change nothing.
    s.reveal('nope');
    expect(s.activeSection).toBe('e');
  });
});

describe('sections a bridge does not offer (#98, #49)', () => {
  it('a hidden section leaves the navigator and the picker; reveal skips it; showing it again puts it back', () => {
    const s = make();
    const hide = five(s);
    s.open();
    hide.c!(true);
    expect(shownTabs()).toEqual(['a', 'b', 'd', 'e']);
    expect(pickerGroups()).toEqual([
      ['General', ['a', 'b']],
      ['Workers', ['d', 'e']],
    ]);
    // The AI group label goes with its only section.
    expect(tablist().querySelector<HTMLElement>('.settings-nav-group[data-group="ai"]')!.hidden).toBe(true);
    expect(panel('c').hidden).toBe(true);
    expect(s.sectionIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    s.reveal('c');
    expect(s.activeSection).toBe('a');
    expect(document.activeElement).not.toBe(panel('c').querySelector('h3'));
    hide.c!(false);
    expect(shownTabs()).toEqual(['a', 'b', 'd', 'e', 'c']);
    s.reveal('c');
    expect(s.activeSection).toBe('c');
    expect(document.activeElement).toBe(panel('c').querySelector('h3'));
  });

  it('hiding the open section falls back to the next shown one (else the one before), and only moves focus that was in it', () => {
    const s = make();
    const hide = five(s);
    s.open();
    tab('b').click();
    // Focus is elsewhere (the body): the fallback leaves it there.
    const body = document.querySelector<HTMLElement>('.settings-body')!;
    body.focus();
    hide.b!(true);
    expect(s.activeSection).toBe('d');
    expect(panel('d').hidden).toBe(false);
    expect(tab('d').getAttribute('aria-selected')).toBe('true');
    expect(tab('d').tabIndex).toBe(0);
    expect(picker().value).toBe('d');
    expect(document.activeElement).toBe(body);
    // Focus inside the hidden panel moves to the new section's tab, never stays on a hidden one.
    panel('d').querySelector('input')!.focus();
    hide.d!(true);
    expect(s.activeSection).toBe('e');
    expect(document.activeElement).toBe(tab('e'));
    // The last in the navigator: falls back to the one before.
    tab('c').click();
    hide.c!(true);
    expect(s.activeSection).toBe('e');
    // Focus on the hidden section's own tab moves too.
    tab('e').focus();
    hide.e!(true);
    expect(s.activeSection).toBe('a');
    expect(document.activeElement).toBe(tab('a'));
  });

  it('the remembered section comes back on the next open once the bridge offers it again', () => {
    const s = make();
    const hide = five(s);
    s.open();
    tab('c').click();
    s.close();
    hide.c!(true);
    expect(s.activeSection).toBe('e');
    hide.c!(false);
    s.open();
    expect(s.activeSection).toBe('c');
  });

  it('with nothing to show, nothing is selected and nothing breaks; the first section shown is selected', () => {
    const s = make();
    const hide = five(s, { a: 'general', b: 'ai' });
    s.open(); // #146: rendered, so each holds its setHidden
    s.close();
    hide.a!(true);
    hide.b!(true);
    s.open();
    expect(s.activeSection).toBeNull();
    expect(sections().every((p) => p.hidden)).toBe(true);
    expect(shownTabs()).toEqual([]);
    hide.b!(false);
    expect(s.activeSection).toBe('b');
    expect(panel('b').hidden).toBe(false);
  });

  it('a section that hides itself while it renders (#146: on the first open) is never selected', () => {
    const s = make();
    s.addSection('a', 'A', (_b, section) => section.setHidden(true), { store: 'bridge', group: 'general' });
    s.addSection('b', 'B', () => {}, { store: 'bridge', group: 'general' });
    s.open();
    expect(s.activeSection).toBe('b');
    expect(panel('a').hidden).toBe(true);
    expect(tab('a').hidden).toBe(true);
  });
});

describe('sections render on the first open (#146)', () => {
  it('renders nothing when added, every section once on the first open (before its open), and later ones at once', () => {
    const s = make();
    const calls: string[] = [];
    const add = (id: string, group: SettingsGroup = 'general') =>
      s.addSection(
        id,
        id.toUpperCase(),
        (body) => {
          calls.push(`render ${id}`);
          body.append(`${id} content`);
          return { open: () => void calls.push(`open ${id}`) };
        },
        { store: 'browser', group },
      );
    add('a');
    add('b', 'ai');
    expect(calls).toEqual([]);
    expect(panel('a').querySelector('.settings-content')!.textContent).toBe('');
    expect(s.sectionIds).toEqual(['a', 'b']);
    expect(shownTabs()).toEqual(['a', 'b']);
    s.open();
    expect(calls).toEqual(['render a', 'render b', 'open a', 'open b']);
    expect(panel('b').querySelector('.settings-content')!.textContent).toBe('b content');
    s.close();
    s.open();
    expect(calls).toEqual(['render a', 'render b', 'open a', 'open b', 'open a', 'open b']);
    calls.length = 0;
    add('c', 'workers');
    expect(calls).toEqual(['render c']);
  });

  it('reveal renders them too (a link that opens the dialog on a section)', () => {
    const s = make();
    const hide = five(s);
    s.reveal('d');
    expect(typeof hide.d).toBe('function');
    expect(panel('d').querySelector('input')).not.toBeNull();
    expect(s.activeSection).toBe('d');
  });

  it('a section that hides itself on its first render is gone from the navigator before anything shows', () => {
    const s = make();
    s.addSection('a', 'A', (_b, section) => section.setHidden(true), { store: 'bridge', group: 'general' });
    s.addSection('b', 'B', () => {}, { store: 'bridge', group: 'ai' });
    s.open();
    expect(shownTabs()).toEqual(['b']);
    expect(pickerGroups()).toEqual([['AI', ['b']]]);
    expect(panel('a').hidden).toBe(true);
    expect(s.activeSection).toBe('b');
  });
});

describe('the game’s Settings sections (#49)', () => {
  it('maps every section app.ts registers to exactly one group, as the issue’s table has it', () => {
    // The registrations are in App's constructor (a whole game to build): read them from the source instead.
    const src = readFileSync(join(import.meta.dirname, '../app.ts'), 'utf8');
    const calls = [...src.matchAll(/addSection\(\s*'([\w-]+)'/g)].map((m) => m[1]);
    const groups = [...src.matchAll(/addSection\(\s*'([\w-]+)'[\s\S]*?\{\s*store: '\w+',\s*group: '(\w+)',?\s*\}/g)].map((m) => [m[1], m[2]]);
    expect(calls).toHaveLength(22);
    expect(groups.map(([id]) => id)).toEqual(calls);
    const table: Record<string, string[]> = {};
    for (const [id, g] of groups) (table[g!] ??= []).push(id!);
    expect(table).toEqual({
      general: ['appearance', 'display', 'floors', 'time', 'notifications', 'bridges'],
      workers: ['harness-models', 'task-levels', 'codex', 'codex-profiles', 'prompt-secrets'], // #108: what you send them; #138: the Codex homes beside the Codex workers
      ai: ['ai', 'followups', 'schedule-suggestions', 'packup', 'activity', 'digest', 'handoff-llm'], // #66: beside the follow-up questions
      integrations: ['repos', 'repo-discovery', 'kaneo', 'telegram'],
    });
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOK_KEY, seatedKey, zoomKey, type KeyLike } from '../laptop/keys';
import {
  BINDINGS,
  GROUPS,
  SCOPE_PARENT,
  bindingCaps,
  chordCaps,
  chordMatches,
  codeLabel,
  findBinding,
  groupsOf,
  keyName,
  pressesBinding,
  reference,
  scopesOf,
  scopesOverlap,
  setLayoutForTest,
  shortcutsMarkdown,
  type Binding,
  type Chord,
  type KeyEventLike,
  type Scope,
} from './shortcuts';

const ALL = BINDINGS as readonly Binding[];

const ev = (code: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({
  code,
  key: o.key ?? (/^Key[A-Z]$/.test(code) ? (o.shiftKey ? code.slice(3) : code.slice(3).toLowerCase()) : code),
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...o,
});

/** A chord as a string two bindings can be compared by (what is pressed, not how it was written). */
const canon = (c: Chord): string => `${c.ctrl ? 'ctrl+' : ''}${c.mod ? 'mod+' : ''}${c.shift ? 'shift+' : ''}${c.key !== undefined ? `key:${c.key}` : `code:${c.code}`}`;

describe('the shortcut table (#124)', () => {
  it('has no two bindings on one chord in scopes that can be live together', () => {
    const clashes: string[] = [];
    for (let i = 0; i < ALL.length; i++) {
      for (let j = i + 1; j < ALL.length; j++) {
        const a = ALL[i] as Binding;
        const b = ALL[j] as Binding;
        const overlap = scopesOf(a).some((x) => scopesOf(b).some((y) => scopesOverlap(x, y)));
        if (!overlap) continue;
        for (const ca of a.keys) for (const cb of b.keys) if (canon(ca) === canon(cb)) clashes.push(`${a.id} / ${b.id}: ${canon(ca)}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('keeps one id, one chord and one scope list per binding', () => {
    const ids = ALL.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of ALL) {
      const chords = b.keys.map(canon);
      expect(new Set(chords).size, b.id).toBe(chords.length);
      expect(scopesOf(b).length, b.id).toBeGreaterThan(0);
      for (const s of scopesOf(b)) expect(SCOPE_PARENT, `${b.id}: ${s}`).toHaveProperty(s);
    }
  });

  it('puts every binding in the reference, under each group it names, and says what it does', () => {
    const ref = reference(false);
    expect(ref.map((g) => g.id)).toEqual(GROUPS.map((g) => g.id));
    for (const b of ALL) {
      for (const g of groupsOf(b)) {
        const entry = ref.find((x) => x.id === g)?.entries.find((e) => e.id === b.id);
        expect(entry, `${b.id} in ${g}`).toBeDefined();
        expect(entry?.label.length).toBeGreaterThan(3);
        expect(entry?.caps.length).toBeGreaterThan(0);
      }
    }
    // Nothing in a group that does not name it.
    for (const g of ref) for (const e of g.entries) expect(groupsOf(ALL.find((b) => b.id === e.id) as Binding)).toContain(g.id);
  });

  it('never asks for Alt, and takes none of the chords the browser keeps', () => {
    // Ctrl/Cmd + T N W L R K D S F and Ctrl+Tab: a page cannot have them. Ctrl+Esc and Ctrl+, (seated) are not on the list.
    // (#147: P is not one: a page can cancel the print dialog, so ⌘/Ctrl+P is the command palette.)
    const reserved = new Set(['KeyT', 'KeyN', 'KeyW', 'KeyL', 'KeyR', 'KeyK', 'KeyD', 'KeyS', 'KeyF', 'Tab']);
    for (const b of ALL) {
      for (const c of b.keys) {
        expect(Object.keys(c)).not.toContain('alt');
        if (c.mod || c.ctrl) expect(reserved.has(c.code ?? ''), `${b.id}: ${canon(c)}`).toBe(false);
      }
    }
  });

  it('lets only a modifier chord fire from a text field, and no single key', () => {
    for (const b of ALL) {
      for (const c of b.keys) {
        if (!c.typing) continue;
        expect(c.mod || c.ctrl, `${b.id}: a field's own keys are not ours`).toBe(true);
        expect(b.readonly).not.toBe(true);
      }
    }
    const all = new Set<Scope>(Object.keys(SCOPE_PARENT) as Scope[]);
    for (const b of ALL) {
      for (const c of b.keys) {
        if (c.typing || b.readonly) continue;
        const press: KeyEventLike = c.key !== undefined ? ev('Comma', { key: c.key, shiftKey: c.key === '?' }) : ev(c.code ?? '', { shiftKey: !!c.shift, ctrlKey: !!c.ctrl, ...(c.code === 'Escape' ? { key: 'Escape' } : {}) });
        const m = findBinding(press, all, true, false);
        expect(m, `${b.id} fired from a field`).toBeNull();
      }
    }
  });

  it('fires the shortcut list from a field with Ctrl (Cmd on a Mac) + /, and `?` only outside one', () => {
    const none = new Set<Scope>(['any']);
    expect(findBinding(ev('Slash', { key: '/', ctrlKey: true }), none, true, false)?.binding.id).toBe('help.field');
    expect(findBinding(ev('Slash', { key: '/', metaKey: true }), none, true, true)?.binding.id).toBe('help.field');
    // The other platform's modifier is not it.
    expect(findBinding(ev('Slash', { key: '/', metaKey: true }), none, true, false)).toBeNull();
    expect(findBinding(ev('Slash', { key: '/', ctrlKey: true }), none, true, true)).toBeNull();
    expect(findBinding(ev('Slash', { key: '?', shiftKey: true }), none, true, false)).toBeNull();
    expect(findBinding(ev('Slash', { key: '?', shiftKey: true }), none, false, false)?.binding.id).toBe('help');
    // `?` is a character: it is the same on a layout where it needs no Shift (and where Shift+/ is something else, it is not).
    expect(findBinding(ev('Comma', { key: '?' }), none, false, false)?.binding.id).toBe('help');
    expect(findBinding(ev('Slash', { key: ';', shiftKey: true }), none, false, false)).toBeNull();
  });

  it('matches modifiers exactly: Shift+N is the inbox, not the next worker; Alt, Ctrl and Cmd never fire a single key', () => {
    const floor = new Set<Scope>(['any', 'floor']);
    expect(findBinding(ev('KeyN'), floor, false, false)?.binding.id).toBe('next-need');
    expect(findBinding(ev('KeyN', { shiftKey: true }), floor, false, false)?.binding.id).toBe('inbox');
    expect(findBinding(ev('KeyR', { shiftKey: true }), floor, false, false)?.binding.id).toBe('run');
    expect(findBinding(ev('KeyR'), floor, false, false)).toBeNull();
    expect(findBinding(ev('KeyL'), floor, false, false)?.binding.id).toBe('elevator');
    expect(findBinding(ev('KeyL', { shiftKey: true }), floor, false, false)?.binding.id).toBe('limits');
    for (const code of ['KeyH', 'KeyI', 'KeyG', 'KeyN', 'KeyB', 'KeyT', 'KeyL']) {
      for (const mod of ['altKey', 'ctrlKey', 'metaKey'] as const) expect(findBinding(ev(code, { [mod]: true }), floor, false, false), `${code} + ${mod}`).toBeNull();
    }
    // Settings is the comma character, wherever the layout puts it.
    expect(findBinding(ev('KeyM', { key: ',' }), floor, false, false)?.binding.id).toBe('settings');
    expect(findBinding(ev('Comma', { key: ';' }), floor, false, false)).toBeNull();
  });

  it('dispatches only the scopes that are live: E means what you aim at', () => {
    const at = (...s: Scope[]) => new Set<Scope>(['any', 'floor', ...s]);
    const e = (s: Set<Scope>) => findBinding(ev('KeyE'), s, false, false)?.binding.id;
    expect(e(at())).toBeUndefined();
    expect(e(at('aim:worker'))).toBe('worker.sit');
    expect(e(at('aim:desk'))).toBe('desk.hire');
    expect(e(at('aim:board'))).toBe('board.open');
    expect(e(at('aim:radio'))).toBe('radio.genre');
    expect(findBinding(ev('KeyR'), at('aim:radio'), false, false)?.binding.id).toBe('radio.track');
    expect(findBinding(ev('KeyC'), at('changes'), false, false)?.binding.id).toBe('worker.changes');
    expect(findBinding(ev('Digit0'), at('aim:worker'), false, false)?.binding.id).toBe('worker.answer');
    expect(findBinding(ev('Numpad7'), at('aim:worker'), false, false)?.binding.id).toBe('worker.answer');
    expect(findBinding(ev('Digit3', { shiftKey: true }), at('aim:worker'), false, false)).toBeNull();
    // Esc: a picked target first, then getting up, then the plan.
    expect(findBinding(ev('Escape'), at('plan', 'sitting', 'selected'), false, false)?.binding.id).toBe('select.clear');
    expect(findBinding(ev('Escape'), at('plan', 'sitting'), false, false)?.binding.id).toBe('stand');
    expect(findBinding(ev('Escape'), at('plan'), false, false)?.binding.id).toBe('plan.close');
    // The city has M, not the floor's keys.
    const city = new Set<Scope>(['any', 'city']);
    expect(findBinding(ev('KeyM'), city, false, false)?.binding.id).toBe('buildings');
    expect(findBinding(ev('KeyH'), city, false, false)).toBeNull();
    expect(findBinding(ev('KeyL'), city, false, false)).toBeNull();
    expect(findBinding(ev('KeyN', { shiftKey: true }), city, false, false)?.binding.id).toBe('inbox');
  });

  it('ignores a composition, a dead key and every key a seated terminal would get', () => {
    const floor = new Set<Scope>(['any', 'floor']);
    expect(findBinding(ev('KeyH', { isComposing: true }), floor, false, false)).toBeNull();
    expect(findBinding(ev('KeyH', { key: 'Process' }), floor, false, false)).toBeNull();
    expect(findBinding(ev('KeyH', { key: 'Dead' }), floor, false, false)).toBeNull();
  });

  it('names a key as the layout labels it, else from its code, and a modifier as the platform does', () => {
    setLayoutForTest(null);
    expect(codeLabel('KeyH')).toBe('H');
    expect(codeLabel('Digit1')).toBe('1');
    expect(codeLabel('PageUp')).toBe('Page Up');
    expect(codeLabel('Escape')).toBe('Esc');
    setLayoutForTest(new Map([['KeyH', 'j'], ['Comma', ';']]));
    expect(codeLabel('KeyH')).toBe('J');
    expect(codeLabel('Comma')).toBe(';');
    expect(keyName('hire')).toBe('J');
    setLayoutForTest(null);
    expect(keyName('hire')).toBe('H');
    expect(keyName('run', false)).toBe('Shift+R');
    expect(keyName('settings')).toBe(',');
    expect(chordCaps({ key: '/', mod: true }, false)).toEqual(['Ctrl', '/']);
    expect(chordCaps({ key: '/', mod: true }, true)).toEqual(['⌘', '/']);
    expect(chordCaps({ key: '/', mod: true }, 'both')).toEqual(['Ctrl/⌘', '/']);
    // The `?` list shows the field chord first for a Mac user, in the dialogs group.
    const field = (reference(true).find((g) => g.id === 'dialogs')?.entries ?? []).find((e) => e.id === 'help.field');
    expect(field?.caps).toEqual([['⌘', '/']]);
    expect(bindingCaps(ALL.find((b) => b.id === 'worker.answer') as Binding, false)).toEqual([['1–9'], ['0']]);
  });

  it('presses a binding by id (the plan limits over a dialog use it)', () => {
    expect(pressesBinding(ev('KeyL', { shiftKey: true }), 'limits', false)).toBe(true);
    expect(pressesBinding(ev('KeyL'), 'limits', false)).toBe(false);
    // Never during a composition or a dead key (like `findBinding`).
    expect(pressesBinding(ev('KeyL', { shiftKey: true, isComposing: true }), 'limits', false)).toBe(false);
    expect(pressesBinding(ev('KeyL', { shiftKey: true, key: 'Process' }), 'limits', false)).toBe(false);
    expect(pressesBinding(ev('KeyL', { shiftKey: true, key: 'Dead' }), 'limits', false)).toBe(false);
    expect(chordMatches(ev('Escape', { ctrlKey: true }), { code: 'Escape', ctrl: true }, true)).toBe(true);
  });

  // #42: was a browser case of e2e/h124-fields.spec.ts, which types every character the table binds (derived the same
  // way there) into each kind of field: the table must keep binding the ones the issue names.
  it('binds the characters the field tests type: ? and , and the letters (both cases) and digits of the single keys', () => {
    const typed = new Set<string>();
    for (const b of ALL) {
      for (const c of b.keys) {
        if (c.mod || c.ctrl) continue;
        if (c.key !== undefined) typed.add(c.key);
        else if (c.code && /^Key[A-Z]$/.test(c.code)) typed.add(c.code.slice(3).toLowerCase()).add(c.code.slice(3));
        else if (c.code && /^Digit\d$/.test(c.code)) typed.add(c.code.slice(5));
      }
    }
    for (const ch of ['?', ',', 'h', 'H', 'i', 'g', 'R', 'N', 'L', 'T', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D', 'e', 'p', 'c', 'x', 'b', 'm', 'n', 'l', 'r', 't', '0', '1', '9']) expect(typed, ch).toContain(ch);
  });
});

describe('the "At a laptop" group follows laptop/keys.ts (#124: seated keys are untouched, and there is no seated help key)', () => {
  const kd = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, code: o.code ?? key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });

  it('lists exactly the chords the seat takes: Esc, Ctrl+Esc, Ctrl+, and Ctrl + − 0', () => {
    expect(seatedKey(kd('Escape'), false).action).toBe('stand');
    expect(seatedKey(kd('Escape', { ctrlKey: true }), false).action).toBe('toggle-transcript');
    expect(seatedKey(kd(LOOK_KEY.key, { ctrlKey: true, code: 'Comma' }), false).action).toBe('look');
    for (const k of ['=', '+']) expect(zoomKey(kd(k, { ctrlKey: true }))).toBe('zoom-in');
    expect(zoomKey(kd('-', { ctrlKey: true }))).toBe('zoom-out');
    expect(zoomKey(kd('0', { ctrlKey: true }))).toBe('zoom-reset');
    const seated = ALL.filter((b) => scopesOf(b).includes('seated'));
    expect(seated.map((b) => b.id)).toEqual(['seat.stand', 'seat.view', 'seat.palette', 'seat.dictate', 'seat.overview', 'seat.look', 'seat.zoom']);
    expect(seated.every((b) => b.readonly)).toBe(true);
    expect(seated.find((b) => b.id === 'seat.look')?.keys[0]).toMatchObject({ key: LOOK_KEY.key, ctrl: true });
    expect(bindingCaps(seated.find((b) => b.id === 'seat.look') as Binding, false)).toEqual([LOOK_KEY.label]);
  });

  it('gives a seated terminal `?` and Ctrl+/ as it always had: they go to the pane, not to a help dialog', () => {
    for (const mac of [false, true]) {
      const q = seatedKey(kd('?', { code: 'Slash', shiftKey: true }), mac);
      expect(q.items).toEqual([{ text: '?' }]);
      expect(q.action).toBeUndefined();
      expect(seatedKey(kd('/', { code: 'Slash', ctrlKey: true }), mac).action).toBeUndefined();
    }
  });
});

describe('the command palette chord (#147)', () => {
  const kd = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, code: o.code ?? key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
  const any = new Set<Scope>(['any']);

  it('is ⌘P on a Mac and Ctrl+P elsewhere, and fires from a text field too', () => {
    expect(findBinding(ev('KeyP', { metaKey: true }), any, false, true)?.binding.id).toBe('palette');
    expect(findBinding(ev('KeyP', { ctrlKey: true }), any, false, false)?.binding.id).toBe('palette');
    expect(findBinding(ev('KeyP', { metaKey: true }), any, true, true)?.binding.id).toBe('palette');
    expect(findBinding(ev('KeyP', { ctrlKey: true }), any, true, false)?.binding.id).toBe('palette');
    // Not the other platform's modifier, not with Shift (Firefox's private window) or Alt, and plain P stays the prompt key.
    expect(findBinding(ev('KeyP', { ctrlKey: true }), any, false, true)).toBeNull();
    expect(findBinding(ev('KeyP', { metaKey: true }), any, false, false)).toBeNull();
    expect(findBinding(ev('KeyP', { ctrlKey: true, shiftKey: true }), any, false, false)).toBeNull();
    expect(findBinding(ev('KeyP', { ctrlKey: true, altKey: true }), any, false, false)).toBeNull();
    expect(findBinding(ev('KeyP'), new Set<Scope>(['any', 'floor', 'aim:worker']), false, false)?.binding.id).toBe('worker.prompt');
    expect(pressesBinding(ev('KeyP', { metaKey: true }), 'palette', true)).toBe(true);
    expect(pressesBinding(ev('KeyP', { ctrlKey: true, isComposing: true }), 'palette', false)).toBe(false);
    expect(keyName('palette', true)).toBe('⌘+P');
    expect(keyName('palette', false)).toBe('Ctrl+P');
  });

  it('is taken from the seated terminal, and the table says so', () => {
    for (const mac of [false, true]) {
      const e = mac ? { metaKey: true } : { ctrlKey: true };
      expect(seatedKey(kd('p', { code: 'KeyP', ...e }), mac), `mac ${mac}`).toEqual({ items: [], action: 'palette', prevent: true });
    }
    // Ctrl+P on a Mac, and other modified Ps, are not it: Ctrl+P is the pane's there, as it was.
    expect(seatedKey(kd('p', { code: 'KeyP', ctrlKey: true }), true).items).toEqual([{ key: 'ctrl+p' }]);
    expect(seatedKey(kd('P', { code: 'KeyP', ctrlKey: true, shiftKey: true }), false).items).toEqual([{ key: 'ctrl+p' }]);
    expect(seatedKey(kd('p', { code: 'KeyP' }), false).items).toEqual([{ text: 'p' }]);
    const row = ALL.find((b) => b.id === 'seat.palette') as Binding;
    expect(row.readonly).toBe(true);
    expect(row.keys).toEqual((ALL.find((b) => b.id === 'palette') as Binding).keys.map(({ typing: _t, ...c }) => c));
  });

  it('names the palette rows from the table: each has a name no other row has', () => {
    const rows = ALL.filter((b) => b.palette);
    const names = rows.map((b) => (b.palette as { name: string }).name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const b of rows) expect(b.readonly, `${b.id} is dispatched`).not.toBe(true);
    // The aimed and the Esc rows need something in front of you: none is a palette row.
    for (const b of rows) {
      expect(b.keys.some((c) => c.code === 'Escape'), b.id).toBe(false);
      expect(scopesOf(b).some((s) => s.startsWith('aim:')), b.id).toBe(false);
    }
  });
});

describe('the dictation bar chord (#213)', () => {
  const kd = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({ key, code: o.code ?? key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
  const any = new Set<Scope>(['any']);
  const space = (o: Partial<KeyEventLike>) => ev('Space', { key: ' ', ...o });

  it('is ⌘⇧Space on a Mac and Ctrl+Shift+Space elsewhere, from a text field too, and not during a composition', () => {
    expect(findBinding(space({ metaKey: true, shiftKey: true }), any, false, true)?.binding.id).toBe('dictate');
    expect(findBinding(space({ ctrlKey: true, shiftKey: true }), any, true, false)?.binding.id).toBe('dictate');
    // Without Shift (an input-source switch on some systems), with Alt, or the other platform's modifier: not it.
    expect(findBinding(space({ ctrlKey: true }), any, true, false)).toBeNull();
    expect(findBinding(space({ ctrlKey: true, shiftKey: true, altKey: true }), any, true, false)).toBeNull();
    expect(findBinding(space({ metaKey: true, shiftKey: true }), any, true, false)).toBeNull();
    expect(pressesBinding(space({ ctrlKey: true, shiftKey: true, isComposing: true }), 'dictate', false)).toBe(false);
    expect(keyName('dictate', false)).toBe('Ctrl+Shift+Space');
    expect(keyName('dictate', true)).toBe('⌘+Shift+Space');
  });

  it('is taken from the seated terminal, and the table says so', () => {
    for (const mac of [false, true]) {
      const e = mac ? { metaKey: true } : { ctrlKey: true };
      expect(seatedKey(kd(' ', { code: 'Space', shiftKey: true, ...e }), mac), `mac ${mac}`).toEqual({ items: [], action: 'dictate', prevent: true });
    }
    // A plain Space and Ctrl+Space stay the pane's.
    expect(seatedKey(kd(' ', { code: 'Space' }), false).action).toBeUndefined();
    expect(seatedKey(kd(' ', { code: 'Space', ctrlKey: true }), false).action).toBeUndefined();
    const row = ALL.find((b) => b.id === 'seat.dictate') as Binding;
    expect(row.readonly).toBe(true);
    expect(row.keys).toEqual((ALL.find((b) => b.id === 'dictate') as Binding).keys.map(({ typing: _t, ...c }) => c));
  });
});

describe('docs/shortcuts.md', () => {
  const file = resolve(import.meta.dirname, '../../../docs/shortcuts.md');
  it('is the table, written out (H3D_WRITE_SHORTCUTS_DOC=1 rewrites it)', () => {
    if (process.env.H3D_WRITE_SHORTCUTS_DOC) writeFileSync(file, shortcutsMarkdown());
    expect(readFileSync(file, 'utf8')).toBe(shortcutsMarkdown());
  });
});

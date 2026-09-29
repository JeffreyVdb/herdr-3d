import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { KeyItem } from '../net/protocol';
import { InputLanes, InputQueue, KEY_NAMES, MAX_ITEMS, MAX_TEXT, mergeItems, seatedKey, takeBatch, textItems, type KeyLike } from './keys';

const kd = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: o.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...o,
});

describe('seatedKey', () => {
  it('sends printable text as text, special keys by their herdr names', () => {
    expect(seatedKey(kd('a'), true)).toEqual({ items: [{ text: 'a' }], prevent: true });
    expect(seatedKey(kd('A', { shiftKey: true, code: 'KeyA' }), true).items).toEqual([{ text: 'A' }]);
    expect(seatedKey(kd(' ', { code: 'Space' }), true).items).toEqual([{ text: ' ' }]);
    expect(seatedKey(kd('é'), true).items).toEqual([{ text: 'é' }]);
    expect(seatedKey(kd('👍🏽'), true).items).toEqual([{ text: '👍🏽' }]);
    for (const [key, name] of [
      ['Enter', 'enter'],
      ['Backspace', 'backspace'],
      ['Delete', 'delete'],
      ['ArrowUp', 'up'],
      ['ArrowDown', 'down'],
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
      ['Home', 'home'],
      ['End', 'end'],
      ['PageUp', 'pageup'],
      ['PageDown', 'pagedown'],
      ['F1', 'f1'],
      ['F12', 'f12'],
    ] as const) {
      expect(seatedKey(kd(key), true), key).toEqual({ items: [{ key: name }], prevent: true });
    }
  });

  it('sends the chords the bridge knows: Shift / Alt+Enter, Alt+Backspace, Shift / Ctrl / Alt+arrows, Cmd+← → on a Mac', () => {
    const k = (key: string, o: Partial<KeyLike>, mac = true) => seatedKey(kd(key, o), mac).items;
    expect(k('Enter', { shiftKey: true })).toEqual([{ key: 'shift+enter' }]);
    expect(k('Enter', { altKey: true })).toEqual([{ key: 'alt+enter' }]);
    expect(k('Backspace', { altKey: true })).toEqual([{ key: 'alt+backspace' }]);
    expect(k('ArrowUp', { shiftKey: true })).toEqual([{ key: 'shift+up' }]);
    expect(k('ArrowLeft', { ctrlKey: true }, false)).toEqual([{ key: 'ctrl+left' }]);
    expect(k('ArrowRight', { altKey: true })).toEqual([{ key: 'alt+right' }]);
    expect(k('ArrowLeft', { metaKey: true })).toEqual([{ key: 'home' }]);
    expect(k('ArrowRight', { metaKey: true })).toEqual([{ key: 'end' }]);
    // No such chord: Shift alone keeps the key, anything else is swallowed.
    expect(k('Home', { shiftKey: true })).toEqual([{ key: 'home' }]);
    expect(k('Enter', { ctrlKey: true })).toEqual([]);
    expect(k('ArrowUp', { ctrlKey: true, shiftKey: true })).toEqual([]);
  });

  it('Tab and Shift+Tab go to the pane, never to the browser focus', () => {
    expect(seatedKey(kd('Tab'), true)).toEqual({ items: [{ key: 'tab' }], prevent: true });
    expect(seatedKey(kd('Tab', { shiftKey: true }), false)).toEqual({ items: [{ key: 'shift+tab' }], prevent: true });
  });

  it('Esc stands you up, Shift+Esc sends Esc to the pane', () => {
    expect(seatedKey(kd('Escape'), true)).toEqual({ items: [], action: 'stand', prevent: true });
    expect(seatedKey(kd('Escape', { shiftKey: true }), true)).toEqual({ items: [{ key: 'esc' }], prevent: true });
    expect(seatedKey(kd('Escape', { ctrlKey: true }), true)).toEqual({ items: [], prevent: true });
  });

  it('Ctrl+letter is a ctrl chord by physical key; Ctrl+other is swallowed', () => {
    expect(seatedKey(kd('c', { ctrlKey: true }), true).items).toEqual([{ key: 'ctrl+c' }]);
    expect(seatedKey(kd('C', { ctrlKey: true, shiftKey: true, code: 'KeyC' }), true).items).toEqual([{ key: 'ctrl+c' }]);
    // AZERTY: the A key sits where QWERTY has Q; the chord is the letter on the key.
    expect(seatedKey(kd('a', { ctrlKey: true, code: 'KeyQ' }), false).items).toEqual([{ key: 'ctrl+a' }]);
    // No Latin letter on the key (e.g. a Cyrillic layout): its position.
    expect(seatedKey(kd('с', { ctrlKey: true, code: 'KeyC' }), false).items).toEqual([{ key: 'ctrl+c' }]);
    expect(seatedKey(kd('1', { ctrlKey: true, code: 'Digit1' }), true)).toEqual({ items: [], prevent: true });
    // Ctrl+V on a Mac is the pane's (Cmd+V pastes).
    expect(seatedKey(kd('v', { ctrlKey: true }), true).items).toEqual([{ key: 'ctrl+v' }]);
  });

  it('paste is Cmd+V on a Mac and Ctrl+V elsewhere, left to the browser (its paste event carries the text)', () => {
    expect(seatedKey(kd('v', { metaKey: true }), true)).toEqual({ items: [], action: 'paste', prevent: false });
    expect(seatedKey(kd('v', { ctrlKey: true }), false)).toEqual({ items: [], action: 'paste', prevent: false });
    expect(seatedKey(kd('V', { ctrlKey: true, shiftKey: true, code: 'KeyV' }), false).action).toBe('paste');
  });

  it("leaves the Mac's Cmd shortcuts, modifiers alone and IME composition to the browser", () => {
    expect(seatedKey(kd('c', { metaKey: true }), true)).toEqual({ items: [], prevent: false });
    expect(seatedKey(kd('Shift'), true)).toEqual({ items: [], prevent: false });
    expect(seatedKey(kd('Meta'), true)).toEqual({ items: [], prevent: false });
    expect(seatedKey(kd('Dead'), true)).toEqual({ items: [], prevent: false });
    expect(seatedKey(kd('a', { isComposing: true }), true)).toEqual({ items: [], prevent: false });
    expect(seatedKey(kd('Process'), false)).toEqual({ items: [], prevent: false });
  });

  it('keeps the game keys to the pane: WASD, L, B, M, X, E are text; Backspace is not a trip to the city', () => {
    for (const k of ['w', 'a', 's', 'd', 'l', 'b', 'm', 'x', 'e', 'p', 'c', 'n', '1']) expect(seatedKey(kd(k), true), k).toEqual({ items: [{ text: k }], prevent: true });
    expect(seatedKey(kd('Backspace'), true).items).toEqual([{ key: 'backspace' }]);
  });

  it('swallows other named keys (no F5 reload, no Insert)', () => {
    expect(seatedKey(kd('F5'), true)).toEqual({ items: [{ key: 'f5' }], prevent: true });
    expect(seatedKey(kd('Insert'), true)).toEqual({ items: [], prevent: true });
    expect(seatedKey(kd('F13'), true)).toEqual({ items: [], prevent: true });
  });

  it('only ever names keys from the allowlist', () => {
    const names = new Set(KEY_NAMES);
    const keys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'PageDown', 'F1', 'F12', 'a', 'z'];
    for (const key of keys)
      for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const o = { shiftKey: !!(m & 1), ctrlKey: !!(m & 2), altKey: !!(m & 4), metaKey: m === 8 };
        for (const mac of [true, false]) for (const it of seatedKey(kd(key, o), mac).items) if ('key' in it) expect(names.has(it.key), it.key).toBe(true);
      }
  });
});

describe('textItems', () => {
  it('turns newlines into Enter and tabs into Tab, drops other control characters', () => {
    expect(textItems('ls\r\ncd x\tq\u0007')).toEqual([{ text: 'ls' }, { key: 'enter' }, { text: 'cd x' }, { key: 'tab' }, { text: 'q' }]);
    expect(textItems('')).toEqual([]);
  });
});

describe('batching', () => {
  it('merges consecutive text and splits long text on the item limit', () => {
    const q: KeyItem[] = [];
    mergeItems(q, [{ text: 'l' }, { text: 's' }, { key: 'enter' }, { text: 'x' }]);
    expect(q).toEqual([{ text: 'ls' }, { key: 'enter' }, { text: 'x' }]);
    const big: KeyItem[] = [];
    mergeItems(big, [{ text: 'é'.repeat(3000) }]);
    expect(big.map((i) => ('text' in i ? new TextEncoder().encode(i.text).length : 0))).toEqual([4096, 1904]);
  });

  it('takes at most 64 items and 8 KiB of text per command', () => {
    const q: KeyItem[] = Array.from({ length: 70 }, () => ({ key: 'up' }));
    expect(takeBatch(q)).toHaveLength(MAX_ITEMS);
    expect(q).toHaveLength(6);
    const t: KeyItem[] = [{ text: 'a'.repeat(4096) }, { text: 'b'.repeat(4096) }, { text: 'c' }];
    const first = takeBatch(t);
    expect(first.reduce((n, i) => n + ('text' in i ? i.text.length : 0), 0)).toBe(MAX_TEXT);
    expect(t).toEqual([{ text: 'c' }]);
  });
});

describe('InputQueue', () => {
  function harness(shell = false) {
    const calls: Array<{ t: string; v: unknown; resolve: (r: CommandResult) => void }> = [];
    const done: Array<[string, CommandResult]> = [];
    const q = new InputQueue(
      {
        keys: (items) => new Promise((resolve) => calls.push({ t: 'keys', v: items, resolve })),
        prompt: (text) => new Promise((resolve) => calls.push({ t: 'prompt', v: text, resolve })),
        done: (k, r) => done.push([k, r]),
      },
      () => shell,
    );
    const ok = async (i: number) => {
      calls[i]?.resolve({ ok: true, data: undefined });
      await Promise.resolve();
      await Promise.resolve();
    };
    return { q, calls, done, ok };
  }

  it('sends the first key at once and batches what is typed while it is on its way, in order', async () => {
    const h = harness();
    h.q.keys([{ text: 'l' }]);
    h.q.keys([{ text: 's' }]);
    h.q.keys([{ key: 'enter' }]);
    h.q.keys([{ text: 'x' }]);
    expect(h.calls.map((c) => c.v)).toEqual([[{ text: 'l' }]]);
    await h.ok(0);
    expect(h.calls.map((c) => c.v)).toEqual([[{ text: 'l' }], [{ text: 's' }, { key: 'enter' }, { text: 'x' }]]);
    await h.ok(1);
    expect(h.q.pending).toBe(false);
    expect(h.done.map((d) => d[0])).toEqual(['keys', 'keys']);
  });

  it('a paste goes after the keys typed before it, as worker.prompt for an agent', async () => {
    const h = harness();
    h.q.keys([{ text: 'a' }]);
    expect(h.q.paste('Run the tests.')).toBe(true);
    h.q.keys([{ text: 'b' }]);
    await h.ok(0);
    expect(h.calls.map((c) => [c.t, c.v])).toEqual([
      ['keys', [{ text: 'a' }]],
      ['prompt', 'Run the tests.'],
    ]);
    await h.ok(1);
    expect(h.calls.map((c) => c.t)).toEqual(['keys', 'prompt', 'keys']);
  });

  it('a plain shell takes a paste as typed keys; an over-long paste is refused', async () => {
    const h = harness(true);
    h.q.paste('ls\npwd\n');
    expect(h.calls.map((c) => c.v)).toEqual([[{ text: 'ls' }, { key: 'enter' }, { text: 'pwd' }, { key: 'enter' }]]);
    const a = harness(false);
    expect(a.q.paste('x'.repeat(16 * 1024 + 1))).toBe(false);
    expect(a.calls).toEqual([]);
  });

  it('clear drops what is not sent yet', async () => {
    const h = harness();
    h.q.keys([{ text: 'a' }]);
    h.q.keys([{ text: 'b' }]);
    h.q.clear();
    await h.ok(0);
    expect(h.calls).toHaveLength(1);
    expect(h.q.pending).toBe(false);
  });
});

describe('InputLanes', () => {
  function lanes() {
    const calls: Array<{ id: string; t: string; v: unknown; resolve: (r: CommandResult) => void }> = [];
    const done: Array<[string, string, boolean]> = [];
    const l = new InputLanes(
      (id, settled) =>
        new InputQueue(
          {
            keys: (items) => new Promise((resolve) => calls.push({ id, t: 'keys', v: items, resolve })),
            prompt: (text) => new Promise((resolve) => calls.push({ id, t: 'prompt', v: text, resolve })),
            done: (k, r) => {
              done.push([id, k, r.ok]);
              settled();
            },
          },
          () => false,
        ),
    );
    const answer = async (i: number, r: CommandResult = { ok: true, data: undefined }) => {
      calls[i]?.resolve(r);
      await Promise.resolve();
      await Promise.resolve();
    };
    return { l, calls, done, answer };
  }

  it('standing up while a paste is on its way still sends what was typed after it, in order', async () => {
    const h = lanes();
    const q = h.l.sit('zippy');
    q.paste('First pasted prompt');
    q.keys([{ text: 'second input' }, { key: 'enter' }]);
    expect(h.calls.map((c) => c.t)).toEqual(['prompt']);
    h.l.stand();
    expect(h.l.draining()).toEqual(['zippy']);
    await h.answer(0);
    expect(h.calls.map((c) => [c.id, c.t, c.v])).toEqual([
      ['zippy', 'prompt', 'First pasted prompt'],
      ['zippy', 'keys', [{ text: 'second input' }, { key: 'enter' }]],
    ]);
    await h.answer(1);
    expect(h.l.draining()).toEqual([]);
    expect(h.done).toEqual([
      ['zippy', 'prompt', true],
      ['zippy', 'keys', true],
    ]);
  });

  it('sitting down again at that worker types behind what is still going out; another worker has its own lane', async () => {
    const h = lanes();
    h.l.sit('zippy').keys([{ text: 'a' }]);
    h.l.sit('zippy').keys([{ text: 'b' }]); // (sit stands you up first)
    expect(h.calls).toHaveLength(1);
    h.l.stand();
    const q = h.l.sit('zippy');
    q.keys([{ text: 'c' }]);
    await h.answer(0);
    expect(h.calls.map((c) => c.v)).toEqual([[{ text: 'a' }], [{ text: 'bc' }]]);
    h.l.sit('pebble').keys([{ text: 'p' }]);
    expect(h.calls.map((c) => c.id)).toEqual(['zippy', 'zippy', 'pebble']);
    expect(h.l.draining()).toEqual(['zippy']);
    // A failure while draining is still an answer (the game shows it); the lane goes when empty.
    await h.answer(1, { ok: false, code: 'input_failed', message: 'input_failed: no' });
    expect(h.done.at(-1)).toEqual(['zippy', 'keys', false]);
    expect(h.l.draining()).toEqual([]);
  });

  it('an idle lane goes as you stand; clear drops what is not sent', async () => {
    const h = lanes();
    h.l.sit('zippy');
    h.l.stand();
    expect(h.l.draining()).toEqual([]);
    const q = h.l.sit('pebble');
    q.keys([{ text: 'a' }]);
    q.keys([{ text: 'b' }]);
    h.l.clear();
    await h.answer(0);
    expect(h.calls).toHaveLength(1);
    expect(h.l.draining()).toEqual([]);
  });
});

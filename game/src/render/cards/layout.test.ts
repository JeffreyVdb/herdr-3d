import { describe, expect, it } from 'vitest';
import { CELL_H, cardLayout, compactOf, isTall, MAX_CHOICES, TALL_H, wrap, type Measure } from './layout';
import { sameCard, type CardData } from './types';

/** A fake measure: 12 px a character at 25 px, scaled by the font size. */
const measure: Measure = (font, text) => {
  const px = Number(/(\d+)px/.exec(font)?.[1] ?? 25);
  return text.length * px * 0.48;
};

const blocked: CardData = {
  name: 'Pixel',
  display: 'needs_you',
  task: 'Allow `go test ./internal/store`?',
  ask: {
    text: 'Run go test ./internal/store?',
    choices: [
      { n: 1, label: 'Yes' },
      { n: 2, label: "Yes, and don't ask again for go test commands in /home/dev/devel/herdr-3d" },
      { n: 3, label: 'No, and tell Claude what to do differently (esc)' },
    ],
    selected: 1,
  },
};

describe('card text layout', () => {
  it('lays out a question and its numbered choices under the name', () => {
    const L = cardLayout(blocked, measure);
    expect(L.rows.map((r) => [r.kind, r.n ?? null, r.selected ?? null])).toEqual([
      ['question', null, null],
      ['choice', 1, true],
      ['choice', 2, false],
      ['choice', 3, false],
    ]);
    expect(L.rows[0]?.text).toBe('Run go test ./internal/store?');
    // A long choice is cut to the card's width, never wrapped.
    expect(L.rows[2]?.text.endsWith('…')).toBe(true);
    expect(measure('600 23px x', L.rows[2]?.text ?? '')).toBeLessThanOrEqual(512 - 12 - 48 - 44);
    // Baselines go down the card, inside the cell.
    const ys = L.rows.map((r) => r.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(L.height).toBeGreaterThan(CELL_H);
    expect(L.height).toBeLessThanOrEqual(TALL_H);
    expect(Math.max(...ys)).toBeLessThan(L.bubble);
  });

  it('wraps a long question to two lines and ellipsizes the rest', () => {
    const q = 'Do you want to make this edit to internal/server/hub.go so the fan-out drops slow consumers after the queue fills up twice in a row?';
    const L = cardLayout({ ...blocked, ask: { text: q, choices: [] } }, measure);
    const lines = L.rows.filter((r) => r.kind === 'question');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text.endsWith('…')).toBe(true);
    expect(lines.map((l) => l.text.replace('…', '')).join(' ').length).toBeLessThan(q.length);
  });

  it('lists at most four choices and names the rest', () => {
    const choices = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, label: `Option ${i + 1}` }));
    const L = cardLayout({ ...blocked, ask: { text: 'Pick one', choices } }, measure);
    expect(L.rows.filter((r) => r.kind === 'choice')).toHaveLength(MAX_CHOICES);
    expect(L.rows.at(-1)).toMatchObject({ kind: 'more', text: '+2 more at its laptop (E)' });
    expect(L.height).toBeLessThanOrEqual(TALL_H);
  });

  it('adds the usage line at the bottom while you look at the worker', () => {
    const L = cardLayout({ ...blocked, usage: '≈$0.09* · 37k tokens · ctx 4%' }, measure);
    expect(L.rows.at(-1)).toMatchObject({ kind: 'usage', text: '≈$0.09* · 37k tokens · ctx 4%' });
    const plain = cardLayout({ name: 'Nibble', display: 'done', task: 'Replay buffer handles since_seq edge cases', usage: '≈$0.09 · 37k tokens' }, measure);
    expect(plain.rows.map((r) => r.kind)).toEqual(['task', 'usage']);
    expect(plain.height).toBeGreaterThan(CELL_H);
    expect(plain.height).toBeLessThan(cardLayout(blocked, measure).height);
  });

  it('keeps even the fullest card inside a tall cell', () => {
    const choices = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, label: 'x'.repeat(80) }));
    const L = cardLayout({ ...blocked, ask: { text: 'y '.repeat(200), choices, selected: 9 }, usage: 'z'.repeat(200) }, measure);
    expect(L.height).toBeLessThanOrEqual(TALL_H);
    expect(Math.max(...L.rows.map((r) => r.y))).toBeLessThan(L.bubble + 6 - 14);
    // Fewer choices fit next to the usage line; the rest are named.
    expect(L.rows.filter((r) => r.kind === 'choice').length).toBeLessThan(MAX_CHOICES);
    expect(L.rows.find((r) => r.kind === 'more')?.text).toMatch(/^\+\d more at its laptop \(E\)$/);
  });
});

describe('what a question is about', () => {
  // Tofu in demo-m5: a Claude Bash permission.
  const tofu: CardData = {
    name: 'Tofu',
    display: 'needs_you',
    task: 'M3 plan',
    ask: {
      text: 'Do you want to proceed?',
      about: ['git push origin h3d/tofu-m3-plan', 'Push the plan branch for review'],
      choices: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, and don't ask again for git push commands in /home/dev/devel/herdr-3d" },
        { n: 3, label: 'No' },
      ],
      selected: 1,
    },
  };

  it('shows the command above the question and all its choices', () => {
    const L = cardLayout(tofu, measure);
    expect(L.rows.map((r) => r.kind)).toEqual(['about', 'about', 'question', 'choice', 'choice', 'choice']);
    expect(L.rows.filter((r) => r.kind === 'about').map((r) => r.text)).toEqual(['git push origin h3d/tofu-m3-plan', 'Push the plan branch for review']);
    const ys = L.rows.map((r) => r.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(L.height).toBeLessThanOrEqual(TALL_H);
    expect(Math.max(...ys)).toBeLessThan(L.bubble);
    // With the usage line too.
    const U = cardLayout({ ...tofu, usage: '≈$0.09 · 37k tokens · ctx 4%' }, measure);
    expect(U.rows.map((r) => r.kind)).toEqual(['about', 'about', 'question', 'choice', 'choice', 'choice', 'usage']);
    expect(U.height).toBeLessThanOrEqual(TALL_H);
  });

  it('cuts a long command to the card, and keeps it when the card is full', () => {
    const long = 'x'.repeat(300);
    const choices = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, label: 'y'.repeat(80) }));
    const L = cardLayout({ ...tofu, ask: { text: 'q '.repeat(200), about: [long, long], choices, selected: 1 }, usage: 'z'.repeat(200) }, measure);
    const about = L.rows.filter((r) => r.kind === 'about');
    expect(about.length).toBeGreaterThanOrEqual(1);
    expect(about[0]?.text.endsWith('…')).toBe(true);
    expect(measure('600 20px x', about[0]?.text ?? '')).toBeLessThanOrEqual(512 - 12 - 48);
    expect(L.rows.filter((r) => r.kind === 'question').length).toBeGreaterThanOrEqual(1);
    expect(L.rows.filter((r) => r.kind === 'choice').length).toBeGreaterThanOrEqual(1);
    expect(L.height).toBeLessThanOrEqual(TALL_H);
    expect(Math.max(...L.rows.map((r) => r.y))).toBeLessThan(L.bubble + 6 - 14);
  });

  it('falls back to a compact card with the command first, and redraws when it changes', () => {
    expect(compactOf(tofu).task).toBe('git push origin h3d/tofu-m3-plan · Do you want to proceed?');
    expect(sameCard(tofu, structuredClone(tofu))).toBe(true);
    expect(sameCard(tofu, { ...tofu, ask: { ...tofu.ask!, about: ['rm -rf important-project'] } })).toBe(false);
  });
});

describe('which cards are tall', () => {
  it('a question or a usage line makes a card tall; compact falls back to the question line', () => {
    expect(isTall(blocked)).toBe(true);
    expect(isTall({ name: 'a', display: 'idle', task: 't' })).toBe(false);
    expect(isTall({ name: 'a', display: 'idle', task: 't', usage: '≈$0.01' })).toBe(true);
    expect(isTall({ ...blocked, ask: { text: '', choices: [] } })).toBe(false);
    expect(compactOf(blocked)).toEqual({ name: 'Pixel', display: 'needs_you', task: 'Run go test ./internal/store?' });
  });

  it('redraws when the question, its cursor or the usage changes', () => {
    expect(sameCard(blocked, structuredClone(blocked))).toBe(true);
    expect(sameCard(blocked, { ...blocked, ask: { ...blocked.ask!, selected: 2 } })).toBe(false);
    expect(sameCard(blocked, { ...blocked, usage: '≈$0.10' })).toBe(false);
    expect(sameCard({ ...blocked, usage: null }, { ...blocked })).toBe(true);
  });
});

describe('wrap', () => {
  it('breaks on words and cuts a single overlong word', () => {
    expect(wrap(measure, '500 25px x', 'aa bb cc dd', 12 * 5, 3)).toEqual(['aa bb', 'cc dd']);
    const w = wrap(measure, '500 25px x', 'abcdefghijklmnopqrstuvwxyz', 12 * 10, 2);
    expect(w).toHaveLength(1);
    expect(w[0]?.endsWith('…')).toBe(true);
  });
});

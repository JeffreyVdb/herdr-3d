/**
 * M5: the text layout of a tall speech-bubble card: a blocked worker's
 * question with its numbered choices, and the usage line of the worker you
 * look at. Pure given a text measure (the canvas's in the game, a fake in
 * tests); `atlasCards.ts` draws what this returns.
 */

import type { CardData } from './types';

export const CELL_W = 512;
export const CELL_H = 152;
/** A tall card's cell: the most a question card can need. */
export const TALL_H = 368;
export const FONT = '"Recursive Variable", system-ui, sans-serif';
export const NAME_FONT = `800 32px ${FONT}`;
export const TASK_FONT = `500 25px ${FONT}`;
export const QUESTION_FONT = `650 25px ${FONT}`;
export const CHOICE_FONT = `600 23px ${FONT}`;
export const KEY_FONT = `800 21px ${FONT}`;
export const USAGE_FONT = `600 21px ${FONT}`;
/** Choices a card lists; the rest are named in a "+2 more" row. */
export const MAX_CHOICES = 4;

/** Width in px of `text` set in `font`. */
export type Measure = (font: string, text: string) => number;

export interface CardRow {
  kind: 'task' | 'question' | 'choice' | 'more' | 'usage';
  text: string;
  /** Baseline, from the cell's top. */
  y: number;
  /** Left edge of the text, from the cell's left. */
  x: number;
  /** A choice's number (its key). */
  n?: number;
  /** The choice the menu's cursor is on. */
  selected?: boolean;
}

export interface CardLayout {
  /** Cell height the card needs (bubble and tail). */
  height: number;
  /** Bubble height (without the tail). */
  bubble: number;
  rows: CardRow[];
}

/** A card that needs a tall cell: it has a question or a usage line. */
export function isTall(c: CardData): boolean {
  return !!(c.ask && (c.ask.text || c.ask.choices.length)) || !!c.usage;
}

/** The compact card a tall one falls back to when no tall cell is free: its question as the task line. */
export function compactOf(c: CardData): CardData {
  if (!c.ask?.text) return c;
  return { name: c.name, display: c.display, task: c.ask.text };
}

const PAD = 6;
const INSET = 24;
const TEXT_W = CELL_W - 2 * PAD - 2 * INSET;
const TAIL = 28;
/** A choice's key cap. */
export const KEY_W = 30;

/** Cuts `s` to fit `w` with an ellipsis. */
export function ellipsizeWith(measure: Measure, font: string, s: string, w: number): string {
  if (measure(font, s) <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(font, `${s.slice(0, mid)}…`) <= w) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

/** Word-wraps `s` into at most `max` lines of width `w`; the last one ellipsized if the text goes on. */
export function wrap(measure: Measure, font: string, s: string, w: number, max: number): string[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  while (i < words.length) {
    const next = cur ? `${cur} ${words[i]}` : (words[i] as string);
    if (!cur || measure(font, next) <= w) {
      cur = next;
      i++;
      continue;
    }
    // On the last line the rest goes in, to be cut with an ellipsis.
    if (lines.length === max - 1) break;
    lines.push(cur);
    cur = '';
  }
  if (cur) lines.push(i < words.length ? `${cur} ${words.slice(i).join(' ')}` : cur);
  return lines.map((l) => ellipsizeWith(measure, font, l, w));
}

/**
 * Rows of a tall card, top to bottom: the name line (drawn with the status
 * tape, not a row), then the question (≤ 2 lines) and its numbered choices
 * for a blocked worker, else the task; last the usage line when set.
 */
export function cardLayout(c: CardData, measure: Measure): CardLayout {
  const x = PAD + INSET;
  const top = PAD + 46; // the name's baseline
  const maxBubble = TALL_H - PAD - TAIL;
  const ask = c.ask && (c.ask.text || c.ask.choices.length) ? c.ask : null;
  const usage = c.usage ? ellipsizeWith(measure, USAGE_FONT, c.usage, TEXT_W) : '';
  const build = (shownChoices: number): { rows: CardRow[]; y: number } => {
    const rows: CardRow[] = [];
    let y = top;
    if (ask) {
      const q = wrap(measure, QUESTION_FONT, ask.text, TEXT_W, 2);
      for (const line of q) {
        y += rows.length ? 30 : 42;
        rows.push({ kind: 'question', text: line, y, x });
      }
      const labelX = x + KEY_W + 14;
      ask.choices.slice(0, shownChoices).forEach((ch, k) => {
        y += k === 0 ? (q.length ? 46 : 50) : 38;
        rows.push({ kind: 'choice', text: ellipsizeWith(measure, CHOICE_FONT, ch.label, PAD + INSET + TEXT_W - labelX), y, x: labelX, n: ch.n, selected: ch.n === ask.selected });
      });
      const more = ask.choices.length - Math.min(shownChoices, ask.choices.length);
      if (more > 0) {
        y += 34;
        rows.push({ kind: 'more', text: `+${more} more at its laptop (E)`, y, x: labelX });
      }
    } else {
      y += 46;
      rows.push({ kind: 'task', text: ellipsizeWith(measure, TASK_FONT, c.task, TEXT_W), y, x });
    }
    if (usage) {
      y += 38;
      rows.push({ kind: 'usage', text: usage, y, x });
    }
    return { rows, y };
  };
  // As many choices as fit (up to MAX_CHOICES), the rest named in a "more" row.
  let n = Math.min(MAX_CHOICES, ask?.choices.length ?? 0);
  let r = build(n);
  while (n > 1 && r.y + 20 - PAD > maxBubble) r = build(--n);
  const bubble = Math.min(maxBubble, Math.max(CELL_H - PAD - TAIL, r.y + 20 - PAD));
  return { height: PAD + bubble + TAIL, bubble, rows: r.rows };
}

/**
 * M5: the text layout of a tall speech-bubble card: a blocked worker's
 * question with its numbered choices, and the usage line of the worker you
 * look at. Pure given a text measure (the canvas's in the game, a fake in
 * tests); `atlasCards.ts` draws what this returns.
 */

import { MONO } from '../../laptop/paint';
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
/** What a question is about (a command, a path): terminal text. */
export const ABOUT_FONT = `600 20px ${MONO}`;
/** M6: a crew member's role tag, verdict stamp and lines. */
export const TAG_FONT = `750 19px ${FONT}`;
export const STAMP_FONT = `850 20px ${FONT}`;
export const CREW_FONT = `600 21px ${FONT}`;
/** M6: crew lines a tall card shows at most. */
export const MAX_CREW = 3;
/** Choices a card lists; the rest are named in a "+2 more" row. */
export const MAX_CHOICES = 4;

/** Width in px of `text` set in `font`. */
export type Measure = (font: string, text: string) => number;

export interface CardRow {
  kind: 'task' | 'about' | 'question' | 'choice' | 'more' | 'usage' | 'tag' | 'crew';
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

/** A card that needs a tall cell: it has a question, a usage line or (M6) crew lines. */
export function isTall(c: CardData): boolean {
  return !!(c.ask && (c.ask.text || c.ask.choices.length)) || !!c.usage || !!c.crew?.length;
}

/** The compact card a tall one falls back to when no tall cell is free: what it is about and its question as the task line. */
export function compactOf(c: CardData): CardData {
  if (!c.ask?.text) return c;
  const about = c.ask.about?.[0];
  const out: CardData = { name: c.name, display: c.display, task: about ? `${about} · ${c.ask.text}` : c.ask.text };
  if (c.tag) out.tag = c.tag;
  return out;
}

const PAD = 6;
const INSET = 24;
const TEXT_W = CELL_W - 2 * PAD - 2 * INSET;
const TAIL = 28;
/** A choice's key cap. */
export const KEY_W = 30;
/** The about lines sit on a plate, this far in. */
export const ABOUT_PAD = 10;

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
 * tape, not a row), then for a blocked worker what its question is about
 * (≤ 2 lines, a command or a path: the operation you approve), the question
 * (≤ 2 lines) and its numbered choices, else the task; last the usage line
 * when set. What does not fit goes in this order: choices past two (named
 * in a "+n more" row), the question's second line, the about's second line,
 * the second choice.
 */
export function cardLayout(c: CardData, measure: Measure): CardLayout {
  const x = PAD + INSET;
  const top = PAD + 46; // the name's baseline
  const maxBubble = TALL_H - PAD - TAIL;
  const ask = c.ask && (c.ask.text || c.ask.choices.length) ? c.ask : null;
  const usage = c.usage ? ellipsizeWith(measure, USAGE_FONT, c.usage, TEXT_W) : '';
  const crew = (c.crew ?? []).filter(Boolean).slice(0, MAX_CREW);
  const build = (shownChoices: number, questionLines: number, aboutLines: number, crewLines = crew.length): { rows: CardRow[]; y: number } => {
    const rows: CardRow[] = [];
    let y = top;
    // M6: the role tag (and a reviewer's stamp) under the name, then the crew member's lines.
    if (c.tag || c.stamp) {
      y += 40;
      rows.push({ kind: 'tag', text: c.tag?.text ?? '', y, x });
    }
    crew.slice(0, crewLines).forEach((line, k) => {
      y += k === 0 ? (c.tag || c.stamp ? 34 : 40) : 28;
      rows.push({ kind: 'crew', text: ellipsizeWith(measure, CREW_FONT, line, TEXT_W), y, x });
    });
    if (ask) {
      const about = (ask.about ?? []).slice(0, aboutLines);
      about.forEach((line, k) => {
        y += k === 0 ? 36 : 26;
        rows.push({ kind: 'about', text: ellipsizeWith(measure, ABOUT_FONT, line, TEXT_W - 2 * ABOUT_PAD), y, x: x + ABOUT_PAD });
      });
      const q = wrap(measure, QUESTION_FONT, ask.text, TEXT_W, questionLines);
      q.forEach((line, k) => {
        y += k ? 30 : 42;
        rows.push({ kind: 'question', text: line, y, x });
      });
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
  // As many choices as fit (up to MAX_CHOICES), the rest named in a "more" row; then fewer lines.
  const n = Math.min(MAX_CHOICES, ask?.choices.length ?? 0);
  const tries: Array<[number, number, number]> = [];
  for (let k = n; k >= Math.min(2, n); k--) tries.push([k, 2, 2]);
  const two = Math.min(2, n);
  tries.push([two, 1, 2], [two, 1, 1], [Math.min(1, n), 1, 1]);
  // M6: then fewer crew lines.
  const all: Array<[number, number, number, number]> = tries.map(([a, b, d]) => [a, b, d, crew.length]);
  for (let k = crew.length - 1; k >= 0; k--) all.push([Math.min(1, n), 1, 1, k]);
  let r = build(...(all[0] as [number, number, number, number]));
  for (const t of all) {
    r = build(...t);
    if (r.y + 20 - PAD <= maxBubble) break;
  }
  const bubble = Math.min(maxBubble, Math.max(CELL_H - PAD - TAIL, r.y + 20 - PAD));
  return { height: PAD + bubble + TAIL, bubble, rows: r.rows };
}

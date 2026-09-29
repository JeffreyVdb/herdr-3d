import type { Display } from '../../world/derive';

export interface CardData {
  name: string;
  display: Display;
  task: string;
  /** M5: a blocked worker's question: its line and numbered choices (the cursor on `selected`). */
  ask?: CardAsk | null;
  /** M5: the usage line, set while you look at the worker (`≈$0.09 · 37k tokens · ctx 4%`). */
  usage?: string | null;
  /** M6: a crew member's role tag (`CODE r2`, `ORCH · in review · 1/3`) on the task line, in its run's colour. */
  tag?: CardTag | null;
  /** M6: a reviewer's verdict stamp. */
  stamp?: CardStamp | null;
  /** M6: the looked-at crew member's lines (issue and run, phase and pass, its report's summary). */
  crew?: string[] | null;
}

export interface CardTag {
  text: string;
  /** CSS colour (the run's). */
  color: string;
}

export interface CardStamp {
  tone: 'pass' | 'changes' | 'incomplete';
  text: string;
}

export interface CardAsk {
  text: string;
  /** What it is about: the command, file or folder the question is for (`questionAbout`), ≤ 2 lines. */
  about?: string[];
  choices: Array<{ n: number; label: string }>;
  selected?: number | undefined;
}

export interface Viewport {
  width: number;
  height: number;
}

const sameAsk = (a: CardAsk | null | undefined, b: CardAsk | null | undefined) =>
  a === b ||
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.text === b.text &&
    (a.about ?? []).join('\n') === (b.about ?? []).join('\n') &&
    a.selected === b.selected &&
    a.choices.length === b.choices.length &&
    a.choices.every((c, i) => c.n === b.choices[i]?.n && c.label === b.choices[i]?.label));

export const sameCard = (a: CardData | null, b: CardData | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.name === b.name &&
    a.display === b.display &&
    a.task === b.task &&
    (a.usage ?? null) === (b.usage ?? null) &&
    sameAsk(a.ask, b.ask) &&
    // M6
    (a.tag?.text ?? null) === (b.tag?.text ?? null) &&
    (a.tag?.color ?? null) === (b.tag?.color ?? null) &&
    (a.stamp?.text ?? null) === (b.stamp?.text ?? null) &&
    (a.stamp?.tone ?? null) === (b.stamp?.tone ?? null) &&
    (a.crew ?? []).join('\n') === (b.crew ?? []).join('\n'));

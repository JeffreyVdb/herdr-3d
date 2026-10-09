import { passWords, PASS_CAP, REPORT_REQUEST, type CrewView } from '../../world/crew';
import { STAMP_FONT, TAG_FONT } from './layout';
import type { CardAsk, CardData, CardStamp, CardTag } from './types';

/**
 * M6: what a write-code crew member's speech bubble adds: the role tag in
 * its run's colour (`CODE r2`; an orchestrator's with its phase and pass),
 * a reviewer's verdict stamp, the report's `input_required` or the over-cap
 * orchestrator's call as the bubble's question, and (the one you look at)
 * its issue and run, phase and report summary.
 */

/** The navy of the board wall: the tag of a crew member without a run. */
export const TAG_DEFAULT = '#24406e';

/** Rubber-stamp ink per verdict (deep enough to read on white and on a pale bubble). */
export const STAMP_INK: Record<CardStamp['tone'], string> = { pass: '#0b8454', changes: '#c42a26', incomplete: '#5d6478' };

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

export function crewTag(c: CrewView): CardTag {
  let text = c.tag;
  if (c.role === 'orch') {
    const parts = [c.tag, c.phase, c.pass !== null ? `${c.pass}/${PASS_CAP}` : null].filter((p): p is string => !!p);
    text = parts.join(' · ');
  }
  return { text, color: c.runColor !== null ? css(c.runColor) : TAG_DEFAULT };
}

/** The bubble's question for a crew member that needs you (null: none). */
export function crewAsk(c: CrewView): CardAsk | null {
  if (c.overCap) return { text: `Past the review cap (${passWords(c.pass ?? PASS_CAP) ?? `pass ${PASS_CAP}`}). It needs your call.`, choices: [] };
  // #215: the report's request, not a question of the agent: say so and who decides (the layout cuts the preview, the
  // inbox and the bar keep the whole text).
  if (c.ask) return { text: c.ask.replace(/\s+/g, ' '), choices: [], about: [`${REPORT_REQUEST} · ${c.askWho ?? ''}`.replace(/ · $/, '')] };
  return null;
}

/** The looked-at crew member's lines: issue and run, then phase and pass (orchestrator) or its report's summary. */
export function crewLines(c: CrewView): string[] {
  const out: string[] = [];
  const where = [c.issue ?? (c.ticket ? `ticket ${c.ticket}` : null), c.run ? `run ${c.run}` : null].filter(Boolean).join(' · ');
  if (where) out.push(where);
  if (c.role === 'orch') {
    const phase = [c.phase ? cap(c.phase) : null, passWords(c.pass ?? undefined)].filter(Boolean).join(' · ');
    if (phase) out.push(phase);
  } else {
    const life = lifeWords(c);
    if (life) out.push(life);
    if (c.askWho) out.push(c.askWho);
    if (c.resolved) out.push(c.resolved.line);
    if (c.summary) out.push(`Report: ${c.summary.replace(/\s+/g, ' ')}`);
  }
  return out;
}

/** A freelancer's lifecycle in words; blocked by its report's request says so (#215), not "Waiting for an answer". */
export function lifeWords(c: CrewView): string {
  if (c.life === 'blocked' && c.ask) return REPORT_REQUEST;
  return LIFE_WORDS[c.life ?? 'idle'];
}

const LIFE_WORDS: Record<NonNullable<CrewView['life']>, string> = {
  hired: 'Just arrived: unpacking',
  onboarding: 'Reading the brief',
  working: 'On it',
  blocked: 'Waiting for an answer',
  reporting: 'Handed in its report',
  idle: 'Waiting for its next step',
};

/**
 * Adds the crew parts to a card (`focus`: you look at it). A freelancer
 * whose terminal has no title yet says what it is doing instead of its
 * label (the tag already says its role and round).
 */
export function withCrew(card: CardData, c: CrewView, focus: boolean, titled = true): CardData {
  card.tag = crewTag(c);
  if (!titled && c.freelancer) card.task = lifeWords(c);
  if (c.stamp) card.stamp = { tone: c.stamp.tone, text: c.stamp.text };
  if (!card.ask) {
    const ask = crewAsk(c);
    if (ask) card.ask = ask;
  }
  if (focus) {
    const lines = crewLines(c);
    if (lines.length) card.crew = lines;
  }
  return card;
}

// ---- drawing -----------------------------------------------------------------

/** The role tag as a pill with its left edge at `x`, centred on baseline `y` - 8; returns its width. */
export function drawTag(g: CanvasRenderingContext2D, x: number, y: number, tag: CardTag, maxW: number): number {
  g.save();
  g.font = TAG_FONT;
  let text = tag.text;
  while (text.length > 1 && g.measureText(text).width + 22 > maxW) text = `${text.slice(0, -2).trimEnd()}…`;
  const w = Math.min(maxW, g.measureText(text).width + 22);
  const h = 28;
  g.beginPath();
  g.roundRect(x, y - 21, w, h, 14);
  g.fillStyle = tag.color;
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText(text, x + 11, y - 1);
  g.restore();
  return w;
}

/** Width a stamp takes (for the text beside it). */
export function stampWidth(g: CanvasRenderingContext2D, s: CardStamp): number {
  g.save();
  g.font = STAMP_FONT;
  const w = g.measureText(s.text).width + 26;
  g.restore();
  return w;
}

/**
 * A reviewer's verdict as a rubber stamp: a double-ruled box, tilted, with
 * its right edge at `right`, centred on `cy`; a white ground so it reads on
 * any bubble (the red of a blocked one too).
 */
export function drawStamp(g: CanvasRenderingContext2D, right: number, cy: number, s: CardStamp): number {
  const w = stampWidth(g, s);
  const h = 34;
  const ink = STAMP_INK[s.tone];
  g.save();
  g.translate(right - w / 2, cy);
  g.rotate(-0.09);
  g.beginPath();
  g.roundRect(-w / 2, -h / 2, w, h, 5);
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = ink;
  g.stroke();
  g.beginPath();
  g.roundRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 3);
  g.lineWidth = 1.2;
  g.stroke();
  g.font = STAMP_FONT;
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(s.text, 0, 1);
  g.restore();
  return w;
}
